/*
 * obs-gstreamer: Direct GPU Render Hub for Ultra-Low Latency Multi-Port RTSP
 *
 * Implements direct GPU off-screen view rendering, single hardware encode pass,
 * and direct RTSP multi-port distribution with zero OBS output queue latency.
 */

#include "gstreamer-render-hub.h"

#include <obs-module.h>
#include <util/threading.h>
#include <util/darray.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <gst/app/gstappsink.h>
#include <gst/rtsp-server/rtsp-server.h>

#include <stdlib.h>
#include <string.h>

struct gst_master_hub;

struct gst_hub_branch {
	char *name;
	char *service;
	char *mount_point;
	GstRTSPServer *server;
	GstRTSPMountPoints *mounts;
	GstRTSPMediaFactory *factory;
	GstElement *appsrc;
	pthread_mutex_t lock;
	bool active;
	int client_count;
	struct gst_master_hub *hub;
	struct gst_hub_branch *next;
};

struct gst_master_hub {
	char *source_type;
	char *source_name;
	obs_view_t *view;
	obs_source_t *source;

	uint32_t width;
	uint32_t height;
	uint32_t fps_num;
	uint32_t fps_den;

	// Double-buffered GPU ping-pong render targets
	gs_texrender_t *texrender[2];
	gs_stagesurf_t *stagesurf[2];
	uint32_t pingpong_idx;
	bool first_frame_primed;

	// Master GStreamer Hardware Encoder
	GstElement *pipe;
	GstElement *appsrc;
	GstElement *appsink;
	pthread_t worker_thread;
	bool worker_running;

	gint connected_client_count; // Number of active remote RTSP clients across all branches
	pthread_mutex_t branch_lock;
	struct gst_hub_branch *branches;
	size_t active_branch_count;
	bool render_hook_active;
};

// Global singleton hub for the active video canvas
static struct gst_master_hub *g_hub = NULL;
static pthread_mutex_t g_hub_mutex = PTHREAD_MUTEX_INITIALIZER;

// Forward declarations
static void hub_render_callback(void *param, uint32_t cx, uint32_t cy);
static void *hub_worker_loop(void *arg);
static void media_configure_cb(GstRTSPMediaFactory *factory, GstRTSPMedia *media, gpointer user_data);
static void media_unprepared_cb(GstRTSPMedia *media, gpointer user_data);

/* Helper to select and initialize the hardware encoder pipeline */
static GstElement *create_master_encoder_pipeline(struct gst_master_hub *hub,
                                                  const char *custom_master_pipe,
                                                  const char *encoder_type,
                                                  int bitrate_kbps,
                                                  int keyint_sec)
{
	gchar *pipe_desc = NULL;

	if (custom_master_pipe && custom_master_pipe[0]) {
		// User provided custom master pipeline
		if (strstr(custom_master_pipe, "appsrc") && strstr(custom_master_pipe, "appsink")) {
			if (strstr(custom_master_pipe, "%u")) {
				pipe_desc = g_strdup_printf(custom_master_pipe, hub->width, hub->height, hub->fps_num, hub->fps_den);
			} else {
				pipe_desc = g_strdup(custom_master_pipe);
			}
		} else {
			// User provided the encoder middle-chain (e.g. "videoconvert ! nvh264enc ... ! h264parse")
			pipe_desc = g_strdup_printf(
				"appsrc name=hub_appsrc is-live=true format=GST_FORMAT_TIME do-timestamp=true "
				"caps=\"video/x-raw, format=BGRA, width=%u, height=%u, framerate=%u/%u\" ! "
				"%s ! "
				"appsink name=hub_appsink sync=false drop=true max-buffers=1",
				hub->width, hub->height, hub->fps_num, hub->fps_den,
				custom_master_pipe);
		}
	} else {
		int bitrate = bitrate_kbps > 0 ? bitrate_kbps : 4000;
		int keyint = keyint_sec > 0 ? keyint_sec : 1;
		int gop_size = keyint * (int)hub->fps_num / (int)hub->fps_den;
		if (gop_size < 15) gop_size = 30;

		gchar *encoder_elem = NULL;
		if (encoder_type && g_strcmp0(encoder_type, "nvh264enc") == 0) {
			encoder_elem = g_strdup_printf(
				"videoconvert ! nvh264enc tune=zerolatency bframes=0 rc-lookahead=0 gop-size=%d bitrate=%d",
				gop_size, bitrate);
		} else if (encoder_type && g_strcmp0(encoder_type, "qsvh264enc") == 0) {
			encoder_elem = g_strdup_printf(
				"videoconvert ! qsvh264enc gop-size=%d bitrate=%d",
				gop_size, bitrate);
		} else if (encoder_type && g_strcmp0(encoder_type, "vaapih264enc") == 0) {
			encoder_elem = g_strdup_printf(
				"videoconvert ! vaapih264enc keyframe-period=%d bitrate=%d",
				gop_size, bitrate);
		} else {
			// Ultra-fast zero-latency x264 fallback (guaranteed to be present on any host)
			encoder_elem = g_strdup_printf(
				"videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast bframes=0 key-int-max=%d bitrate=%d",
				gop_size, bitrate);
		}

		pipe_desc = g_strdup_printf(
			"appsrc name=hub_appsrc is-live=true format=GST_FORMAT_TIME do-timestamp=true "
			"caps=\"video/x-raw, format=BGRA, width=%u, height=%u, framerate=%u/%u\" ! "
			"%s ! h264parse config-interval=-1 ! "
			"appsink name=hub_appsink sync=false drop=true max-buffers=1",
			hub->width, hub->height, hub->fps_num, hub->fps_den,
			encoder_elem);

		g_free(encoder_elem);
	}

	GError *error = NULL;
	GstElement *pipe = gst_parse_launch(pipe_desc, &error);
	blog(LOG_INFO, "[obs-gstreamer-hub] Launching master pipeline: %s", pipe_desc);
	g_free(pipe_desc);

	if (error) {
		blog(LOG_ERROR, "[obs-gstreamer-hub] Failed to create master encoder pipeline: %s", error->message);
		g_clear_error(&error);
		return NULL;
	}

	return pipe;
}

/* Master GPU Frame Capture Callback */
static void hub_render_callback(void *param, uint32_t cx, uint32_t cy)
{
	(void)cx; (void)cy;
	struct gst_master_hub *hub = (struct gst_master_hub *)param;
	if (!hub || !hub->view) return;

	// On-Demand Encoding: If no client is connected to any branch, do NOT render or encode!
	if (g_atomic_int_get(&hub->connected_client_count) <= 0) {
		hub->first_frame_primed = false;
		return;
	}

	uint32_t cur = hub->pingpong_idx;
	uint32_t prev = 1 - cur;

	// 1. Render the offscreen view into the current pingpong texture
	if (hub->texrender[cur]) {
		gs_texrender_begin(hub->texrender[cur], hub->width, hub->height);
		gs_enable_blending(false);
		obs_view_render(hub->view);
		gs_texrender_end(hub->texrender[cur]);

		// Copy texture into staging surface for zero-stall DMA
		gs_texture_t *tex = gs_texrender_get_texture(hub->texrender[cur]);
		if (tex && hub->stagesurf[cur]) {
			gs_stage_texture(hub->stagesurf[cur], tex);
		}
	}

	// 2. Map the PREVIOUS frame's staging surface (GPU finished DMA, zero CPU wait)
	if (hub->first_frame_primed && hub->stagesurf[prev] && hub->appsrc) {
		uint8_t *data = NULL;
		uint32_t linesize = 0;
		if (gs_stagesurf_map(hub->stagesurf[prev], &data, &linesize)) {
			size_t frame_bytes = (size_t)hub->width * (size_t)hub->height * 4;
			GstBuffer *buf = gst_buffer_new_allocate(NULL, frame_bytes, NULL);
			if (buf) {
				GstMapInfo map;
				if (gst_buffer_map(buf, &map, GST_MAP_WRITE)) {
					// Copy row-by-row if linesize differs from width*4
					if (linesize == hub->width * 4) {
						memcpy(map.data, data, frame_bytes);
					} else {
						for (uint32_t y = 0; y < hub->height; y++) {
							memcpy(map.data + y * hub->width * 4, data + y * linesize, hub->width * 4);
						}
					}
					gst_buffer_unmap(buf, &map);

					GST_BUFFER_DURATION(buf) = gst_util_uint64_scale_int(1, GST_SECOND, hub->fps_num / hub->fps_den);
					gst_app_src_push_buffer(GST_APP_SRC(hub->appsrc), buf);
				} else {
					gst_buffer_unref(buf);
				}
			}
			gs_stagesurf_unmap(hub->stagesurf[prev]);
		}
	} else {
		hub->first_frame_primed = true;
	}

	// Swap pingpong index
	hub->pingpong_idx = prev;
}

/* Worker loop pulling compressed H.264 packets from appsink and pushing to RTSP branches */
static void *hub_worker_loop(void *arg)
{
	struct gst_master_hub *hub = (struct gst_master_hub *)arg;

	while (hub->worker_running) {
		GstSample *sample = gst_app_sink_try_pull_sample(GST_APP_SINK(hub->appsink), 20 * GST_MSECOND);
		if (!sample) continue;

		GstBuffer *buf = gst_sample_get_buffer(sample);
		if (buf) {
			pthread_mutex_lock(&hub->branch_lock);
			struct gst_hub_branch *curr = hub->branches;
			while (curr) {
				pthread_mutex_lock(&curr->lock);
				if (curr->active && curr->appsrc) {
					// Push a copy/ref to this RTSP client's pipeline
					gst_app_src_push_buffer(GST_APP_SRC(curr->appsrc), gst_buffer_ref(buf));
				}
				pthread_mutex_unlock(&curr->lock);
				curr = curr->next;
			}
			pthread_mutex_unlock(&hub->branch_lock);
		}

		gst_sample_unref(sample);
	}

	return NULL;
}

/* RTSP client connects and prepares media */
static void media_configure_cb(GstRTSPMediaFactory *factory, GstRTSPMedia *media, gpointer user_data)
{
	(void)factory;
	struct gst_hub_branch *branch = (struct gst_hub_branch *)user_data;
	GstElement *element = gst_rtsp_media_get_element(media);
	GstElement *appsrc = gst_bin_get_by_name(GST_BIN(element), "appsrc_video");

	if (!appsrc) {
		blog(LOG_WARNING, "[obs-gstreamer-hub] RTSP media has no appsrc_video");
		gst_object_unref(element);
		return;
	}

	gst_app_src_set_stream_type(GST_APP_SRC(appsrc), GST_APP_STREAM_TYPE_STREAM);
	gst_app_src_set_latency(GST_APP_SRC(appsrc), 0, 0);

	pthread_mutex_lock(&branch->lock);
	if (branch->appsrc) {
		gst_object_unref(branch->appsrc);
	}
	branch->appsrc = appsrc;
	branch->client_count++;
	pthread_mutex_unlock(&branch->lock);

	if (branch->hub) {
		int prev = g_atomic_int_add(&branch->hub->connected_client_count, 1);
		if (prev == 0) {
			blog(LOG_INFO, "[obs-gstreamer-hub] First client connected! Activating GPU render & encoder pipeline.");
			if (branch->hub->pipe) {
				gst_element_set_state(branch->hub->pipe, GST_STATE_PLAYING);
			}
		}
	}

	g_signal_connect(media, "unprepared", G_CALLBACK(media_unprepared_cb), branch);
	gst_object_unref(element);
	blog(LOG_INFO, "[obs-gstreamer-hub] RTSP client connected on port %s%s (Active clients: %d)",
		branch->service, branch->mount_point,
		branch->hub ? g_atomic_int_get(&branch->hub->connected_client_count) : 1);
}

static void media_unprepared_cb(GstRTSPMedia *media, gpointer user_data)
{
	(void)media;
	struct gst_hub_branch *branch = (struct gst_hub_branch *)user_data;
	pthread_mutex_lock(&branch->lock);
	if (branch->client_count > 0) {
		branch->client_count--;
	}
	if (branch->client_count == 0 && branch->appsrc) {
		gst_object_unref(branch->appsrc);
		branch->appsrc = NULL;
	}
	pthread_mutex_unlock(&branch->lock);

	if (branch->hub) {
		int remaining = g_atomic_int_add(&branch->hub->connected_client_count, -1) - 1;
		if (remaining <= 0) {
			g_atomic_int_set(&branch->hub->connected_client_count, 0);
			blog(LOG_INFO, "[obs-gstreamer-hub] Last client disconnected. Pausing GPU render & encoder (0%% GPU/CPU usage).");
			branch->hub->first_frame_primed = false;
			if (branch->hub->pipe) {
				gst_element_set_state(branch->hub->pipe, GST_STATE_PAUSED);
			}
		} else {
			blog(LOG_INFO, "[obs-gstreamer-hub] RTSP client disconnected from port %s%s (Remaining clients: %d)",
				branch->service, branch->mount_point, remaining);
		}
	}
}

/* Initialize master hub for a given source */
static bool hub_init(struct gst_master_hub *hub, const gst_hub_output_params_t *params)
{
	hub->source_type = bstrdup(params->source_type ? params->source_type : "Program Output");
	hub->source_name = bstrdup(params->source_name ? params->source_name : "");

	struct obs_video_info ovi;
	obs_get_video_info(&ovi);
	hub->width = ovi.output_width ? ovi.output_width : 1920;
	hub->height = ovi.output_height ? ovi.output_height : 1080;
	hub->fps_num = ovi.fps_num ? ovi.fps_num : 60;
	hub->fps_den = ovi.fps_den ? ovi.fps_den : 1;

	// Resolve the OBS source
	if (strcmp(hub->source_type, "Scene") == 0) {
		obs_scene_t *sc = obs_get_scene_by_name(hub->source_name);
		hub->source = sc ? obs_scene_get_source(sc) : NULL;
		if (hub->source) obs_source_addref(hub->source);
		if (sc) obs_scene_release(sc);
	} else if (strcmp(hub->source_type, "Source") == 0) {
		hub->source = obs_get_source_by_name(hub->source_name);
	} else {
		// Program Output: grab channel 0
		hub->source = obs_get_output_source(0);
	}

	if (!hub->source) {
		blog(LOG_ERROR, "[obs-gstreamer-hub] Failed to resolve source '%s' of type '%s'",
			hub->source_name, hub->source_type);
		return false;
	}

	// Create dedicated off-screen view
	hub->view = obs_view_create();
	obs_view_set_source(hub->view, 0, hub->source);

	// Create double-buffered GPU render targets
	obs_enter_graphics();
	hub->texrender[0] = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	hub->texrender[1] = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	hub->stagesurf[0] = gs_stagesurface_create(hub->width, hub->height, GS_RGBA);
	hub->stagesurf[1] = gs_stagesurface_create(hub->width, hub->height, GS_RGBA);
	obs_leave_graphics();

	hub->pingpong_idx = 0;
	hub->first_frame_primed = false;

	// Launch Master GStreamer Hardware Encoder
	hub->pipe = create_master_encoder_pipeline(hub, params->master_pipeline, params->encoder_type, params->bitrate_kbps, params->keyint_sec);
	if (!hub->pipe) {
		return false;
	}

	hub->appsrc = gst_bin_get_by_name(GST_BIN(hub->pipe), "hub_appsrc");
	hub->appsink = gst_bin_get_by_name(GST_BIN(hub->pipe), "hub_appsink");

	hub->connected_client_count = 0;
	gst_element_set_state(hub->pipe, GST_STATE_PAUSED);

	// Start worker thread
	hub->worker_running = true;
	pthread_create(&hub->worker_thread, NULL, hub_worker_loop, hub);

	// Hook into OBS GPU render thread
	obs_add_main_render_callback(hub_render_callback, hub);
	hub->render_hook_active = true;

	blog(LOG_INFO, "[obs-gstreamer-hub] Master GPU Render Hub started (%ux%u @ %u/%u fps)",
		hub->width, hub->height, hub->fps_num, hub->fps_den);

	return true;
}

/* Teardown master hub */
static void hub_destroy(struct gst_master_hub *hub)
{
	if (!hub) return;

	if (hub->render_hook_active) {
		obs_remove_main_render_callback(hub_render_callback, hub);
		hub->render_hook_active = false;
	}

	hub->worker_running = false;
	pthread_join(hub->worker_thread, NULL);

	if (hub->pipe) {
		gst_element_set_state(hub->pipe, GST_STATE_NULL);
		if (hub->appsrc) gst_object_unref(hub->appsrc);
		if (hub->appsink) gst_object_unref(hub->appsink);
		gst_object_unref(hub->pipe);
		hub->pipe = NULL;
	}

	obs_enter_graphics();
	for (int i = 0; i < 2; i++) {
		if (hub->texrender[i]) {
			gs_texrender_destroy(hub->texrender[i]);
			hub->texrender[i] = NULL;
		}
		if (hub->stagesurf[i]) {
			gs_stagesurface_destroy(hub->stagesurf[i]);
			hub->stagesurf[i] = NULL;
		}
	}
	obs_leave_graphics();

	if (hub->view) {
		obs_view_destroy(hub->view);
		hub->view = NULL;
	}
	if (hub->source) {
		obs_source_release(hub->source);
		hub->source = NULL;
	}

	bfree(hub->source_type);
	bfree(hub->source_name);
	pthread_mutex_destroy(&hub->branch_lock);
	bfree(hub);

	blog(LOG_INFO, "[obs-gstreamer-hub] Master GPU Render Hub destroyed cleanly");
}

/* Public API: Start a direct RTSP output branch */
gst_hub_branch_t *gst_render_hub_start_branch(const gst_hub_output_params_t *params)
{
	if (!params) return NULL;

	pthread_mutex_lock(&g_hub_mutex);

	// Ensure master hub is running
	if (!g_hub) {
		g_hub = bzalloc(sizeof(struct gst_master_hub));
		pthread_mutex_init(&g_hub->branch_lock, NULL);
		if (!hub_init(g_hub, params)) {
			hub_destroy(g_hub);
			g_hub = NULL;
			pthread_mutex_unlock(&g_hub_mutex);
			return NULL;
		}
	}

	// Create new RTSP branch
	struct gst_hub_branch *branch = bzalloc(sizeof(struct gst_hub_branch));
	branch->name = bstrdup(params->name ? params->name : "Output");
	branch->service = bstrdup(params->rtsp_service && params->rtsp_service[0] ? params->rtsp_service : "8554");
	branch->mount_point = bstrdup(params->rtsp_mount && params->rtsp_mount[0] ? params->rtsp_mount : "/live");
	branch->hub = g_hub;
	pthread_mutex_init(&branch->lock, NULL);

	// Setup GStreamer RTSP Server for this branch
	branch->server = gst_rtsp_server_new();
	gst_rtsp_server_set_service(branch->server, branch->service);

	branch->mounts = gst_rtsp_server_get_mount_points(branch->server);
	branch->factory = gst_rtsp_media_factory_new();
	gst_rtsp_media_factory_set_shared(branch->factory, TRUE);

	// The branch pipeline packetizes already-compressed H.264 into RTP (zero encode overhead)
	const char *default_launch_str =
		"( appsrc name=appsrc_video is-live=true format=GST_FORMAT_TIME do-timestamp=true "
		"caps=\"video/x-h264, stream-format=byte-stream, alignment=au\" ! "
		"h264parse config-interval=-1 ! rtph264pay name=pay0 pt=96 )";

	const char *launch_str = (params->rtsp_pipeline && params->rtsp_pipeline[0]) ?
		params->rtsp_pipeline : default_launch_str;

	gst_rtsp_media_factory_set_launch(branch->factory, launch_str);
	g_signal_connect(branch->factory, "media-configure", G_CALLBACK(media_configure_cb), branch);
	gst_rtsp_mount_points_add_factory(branch->mounts, branch->mount_point, branch->factory);

	if (gst_rtsp_server_attach(branch->server, NULL) == 0) {
		blog(LOG_ERROR, "[obs-gstreamer-hub] Failed to attach RTSP server on port %s", branch->service);
		gst_object_unref(branch->server);
		bfree(branch->name);
		bfree(branch->service);
		bfree(branch->mount_point);
		pthread_mutex_destroy(&branch->lock);
		bfree(branch);
		pthread_mutex_unlock(&g_hub_mutex);
		return NULL;
	}

	branch->active = true;

	// Link branch into hub
	pthread_mutex_lock(&g_hub->branch_lock);
	branch->next = g_hub->branches;
	g_hub->branches = branch;
	g_hub->active_branch_count++;
	pthread_mutex_unlock(&g_hub->branch_lock);

	blog(LOG_INFO, "[obs-gstreamer-hub] Branch started: rtsp://127.0.0.1:%s%s", branch->service, branch->mount_point);

	pthread_mutex_unlock(&g_hub_mutex);
	return branch;
}

/* Public API: Stop an active RTSP output branch */
void gst_render_hub_stop_branch(gst_hub_branch_t *branch)
{
	if (!branch) return;

	pthread_mutex_lock(&g_hub_mutex);

	struct gst_master_hub *hub = branch->hub;
	if (hub) {
		pthread_mutex_lock(&hub->branch_lock);
		struct gst_hub_branch **curr = &hub->branches;
		while (*curr) {
			if (*curr == branch) {
				*curr = branch->next;
				hub->active_branch_count--;
				break;
			}
			curr = &(*curr)->next;
		}
		pthread_mutex_unlock(&hub->branch_lock);
	}

	pthread_mutex_lock(&branch->lock);
	branch->active = false;
	int branch_clients = branch->client_count;
	branch->client_count = 0;
	if (branch->appsrc) {
		gst_object_unref(branch->appsrc);
		branch->appsrc = NULL;
	}
	if (branch->server) {
		gst_object_unref(branch->server);
		branch->server = NULL;
	}
	pthread_mutex_unlock(&branch->lock);

	if (hub && branch_clients > 0) {
		int remaining = g_atomic_int_add(&hub->connected_client_count, -branch_clients) - branch_clients;
		if (remaining <= 0) {
			g_atomic_int_set(&hub->connected_client_count, 0);
			hub->first_frame_primed = false;
			if (hub->pipe) {
				gst_element_set_state(hub->pipe, GST_STATE_PAUSED);
			}
		}
	}

	bfree(branch->name);
	bfree(branch->service);
	bfree(branch->mount_point);
	pthread_mutex_destroy(&branch->lock);
	bfree(branch);

	// If no more branches remain on the hub, cleanly destroy the master hub
	if (hub && hub->active_branch_count == 0) {
		hub_destroy(hub);
		g_hub = NULL;
	}

	pthread_mutex_unlock(&g_hub_mutex);
}

/* Public API: Check if branch is active */
bool gst_render_hub_is_branch_active(const gst_hub_branch_t *branch)
{
	return branch != NULL && branch->active;
}

/* Public API: Global shutdown */
void gst_render_hub_shutdown(void)
{
	pthread_mutex_lock(&g_hub_mutex);
	if (g_hub) {
		while (g_hub->branches) {
			gst_hub_branch_t *next = g_hub->branches->next;
			gst_render_hub_stop_branch(g_hub->branches);
			(void)next;
		}
	}
	pthread_mutex_unlock(&g_hub_mutex);
}
