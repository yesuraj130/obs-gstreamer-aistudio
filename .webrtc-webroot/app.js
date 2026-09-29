(function () {
  'use strict';

  // DOM Elements
  var video = document.getElementById('video');
  var statusEl = document.getElementById('status');
  var testCanvas = document.getElementById('test-canvas');
  var offlineOverlay = document.getElementById('offline-overlay');
  var overlayTitle = document.getElementById('overlay-title');
  var overlayDesc = document.getElementById('overlay-desc');
  var lblEndpoint = document.getElementById('lbl-endpoint');
  var lblPortStatus = document.getElementById('lbl-port-status');
  var lblRetryCountdown = document.getElementById('lbl-retry-countdown');
  var btnReconnectNow = document.getElementById('btn-reconnect-now');
  var btnSwitchTestPattern = document.getElementById('btn-switch-test-pattern');

  var badgeSourceMode = document.getElementById('badge-source-mode');
  var badgeStreamState = document.getElementById('badge-stream-state');
  var streamPulse = document.getElementById('stream-pulse');
  var streamText = document.getElementById('stream-text');
  var badgeResolution = document.getElementById('badge-resolution');
  var badgeBitrate = document.getElementById('badge-bitrate');
  var audioVuMeter = document.getElementById('audio-vu-meter');

  var backendDot = document.getElementById('backend-dot');
  var backendText = document.getElementById('backend-text');
  var clockDisplay = document.getElementById('clock-display');

  // Stats Elements
  var statPcState = document.getElementById('stat-pc-state');
  var statIceState = document.getElementById('stat-ice-state');
  var statSignaling = document.getElementById('stat-signaling');
  var statTracks = document.getElementById('stat-tracks');
  var statDimensions = document.getElementById('stat-dimensions');
  var statFps = document.getElementById('stat-fps');
  var statBitrate = document.getElementById('stat-bitrate');
  var statPacketloss = document.getElementById('stat-packetloss');

  // Source Selector Buttons
  var btnModeWhep = document.getElementById('btn-mode-whep');
  var btnModeTest = document.getElementById('btn-mode-test');
  var btnModeCustom = document.getElementById('btn-mode-custom');
  var customWhepBar = document.getElementById('custom-whep-bar');
  var inputCustomUrl = document.getElementById('input-custom-url');
  var btnConnectCustom = document.getElementById('btn-connect-custom');

  // Player Controls
  var btnPlayPause = document.getElementById('btn-play-pause');
  var iconPlay = document.getElementById('icon-play');
  var iconPause = document.getElementById('icon-pause');
  var btnMute = document.getElementById('btn-mute');
  var iconMuted = document.getElementById('icon-muted');
  var iconUnmuted = document.getElementById('icon-unmuted');
  var volumeSlider = document.getElementById('volume-slider');
  var btnSnapshot = document.getElementById('btn-snapshot');
  var btnPip = document.getElementById('btn-pip');
  var btnFullscreen = document.getElementById('btn-fullscreen');
  var btnToggleStats = document.getElementById('btn-toggle-stats');
  var sidePanel = document.getElementById('side-panel');
  var btnClearLogs = document.getElementById('btn-clear-logs');

  // Guide Modal
  var btnOpenGuide = document.getElementById('btn-open-guide');
  var btnCloseGuide = document.getElementById('btn-close-guide');
  var btnModalGotIt = document.getElementById('btn-modal-got-it');
  var modalGuide = document.getElementById('modal-guide');

  // State Variables
  var currentMode = 'whep'; // 'whep' | 'test' | 'custom'
  var whepUrl = '/whep';
  var pc = null;
  var loopbackSender = null;
  var reconnectTimer = null;
  var countdownTimer = null;
  var reconnectSeconds = 0;
  var reconnectAttempts = 0;
  var statsInterval = null;
  var prevBytesReceived = 0;
  var prevStatsTimestamp = 0;
  var backendOnline = false;
  var isManualDisconnect = false;

  // Test Pattern Generator State
  var testAnimationId = null;
  var testAudioCtx = null;
  var testOscillator = null;

  // Logger helper
  function log(msg, type) {
    var now = new Date();
    var timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    var prefix = '[' + timeStr + '] ';
    var line = prefix + msg;
    console.log('[obs-gstreamer]', line);

    if (statusEl) {
      statusEl.textContent = line + '\n' + statusEl.textContent.slice(0, 4000);
    }
  }

  function setStreamBadge(state, label) {
    if (!badgeStreamState || !streamPulse || !streamText) return;

    if (state === 'live') {
      streamPulse.className = 'w-2 h-2 rounded-full bg-red-500 animate-pulse';
      badgeStreamState.className = 'px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider backdrop-blur-md bg-red-950/80 border border-red-700/80 text-red-200 flex items-center gap-2 shadow-lg';
      streamText.textContent = label || 'LIVE';
      offlineOverlay.classList.add('hidden');
    } else if (state === 'connecting') {
      streamPulse.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
      badgeStreamState.className = 'px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider backdrop-blur-md bg-amber-950/80 border border-amber-700/80 text-amber-200 flex items-center gap-2 shadow-lg';
      streamText.textContent = label || 'CONNECTING';
    } else if (state === 'test') {
      streamPulse.className = 'w-2 h-2 rounded-full bg-emerald-400';
      badgeStreamState.className = 'px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider backdrop-blur-md bg-emerald-950/80 border border-emerald-700/80 text-emerald-200 flex items-center gap-2 shadow-lg';
      streamText.textContent = label || 'TEST PATTERN';
      offlineOverlay.classList.add('hidden');
    } else {
      streamPulse.className = 'w-2 h-2 rounded-full bg-slate-500';
      badgeStreamState.className = 'px-2.5 py-1 rounded-md text-xs font-semibold uppercase tracking-wider backdrop-blur-md bg-slate-900/80 border border-slate-700 text-slate-300 flex items-center gap-2 shadow-lg';
      streamText.textContent = label || 'OFFLINE';
      if (currentMode !== 'test') {
        offlineOverlay.classList.remove('hidden');
      }
    }
  }

  // Real-time clock display in side panel
  setInterval(function () {
    var now = new Date();
    if (clockDisplay) {
      clockDisplay.textContent = now.toTimeString().split(' ')[0];
    }
  }, 1000);

  // Poll backend health status via /api/status
  function checkBackendHealth() {
    fetch('/api/status')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var wasOnline = backendOnline;
        backendOnline = Boolean(data && data.online);

        if (backendDot && backendText) {
          if (backendOnline) {
            backendDot.className = 'w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50';
            backendText.textContent = 'OBS Port 8888 Online';
            lblPortStatus.className = 'text-emerald-400 font-semibold';
            lblPortStatus.textContent = '127.0.0.1:8888 (LISTENING)';
          } else {
            backendDot.className = 'w-2 h-2 rounded-full bg-amber-400';
            backendText.textContent = 'OBS Port 8888 Offline';
            lblPortStatus.className = 'text-amber-400 font-semibold';
            lblPortStatus.textContent = '127.0.0.1:8888 (ECONNREFUSED - Waiting for OBS)';
          }
        }

        // If backend just transitioned to online while in WHEP mode and offline, connect immediately!
        if (!wasOnline && backendOnline && currentMode === 'whep' && (!pc || pc.connectionState === 'closed')) {
          log('OBS GStreamer server detected online on port 8888! Initiating connection...', 'info');
          connectWhep();
        }
      })
      .catch(function () {
        if (backendDot && backendText) {
          backendDot.className = 'w-2 h-2 rounded-full bg-slate-600';
          backendText.textContent = 'Backend Offline';
        }
      });
  }

  setInterval(checkBackendHealth, 3000);
  checkBackendHealth();

  // Clean teardown of existing connections
  function cleanupConnection() {
    clearTimeout(reconnectTimer);
    clearInterval(countdownTimer);
    clearInterval(statsInterval);
    statsInterval = null;

    if (pc) {
      try {
        pc.ontrack = null;
        pc.oniceconnectionstatechange = null;
        pc.onconnectionstatechange = null;
        pc.onsignalingstatechange = null;
        pc.close();
      } catch (e) {}
      pc = null;
    }

    if (loopbackSender) {
      try {
        loopbackSender.close();
      } catch (e) {}
      loopbackSender = null;
    }

    if (testAnimationId) {
      cancelAnimationFrame(testAnimationId);
      testAnimationId = null;
    }

    if (testAudioCtx) {
      try { testAudioCtx.close(); } catch (e) {}
      testAudioCtx = null;
    }

    if (video.srcObject) {
      try {
        var tracks = video.srcObject.getTracks();
        tracks.forEach(function (t) { t.stop(); });
      } catch (e) {}
      video.srcObject = null;
    }

    statPcState.textContent = 'closed';
    statIceState.textContent = 'closed';
    statSignaling.textContent = 'closed';
    statTracks.textContent = 'none';
    statDimensions.textContent = '-';
    statFps.textContent = '0 fps';
    statBitrate.textContent = '0 kbps';
    badgeResolution.classList.add('hidden');
    badgeBitrate.classList.add('hidden');
    audioVuMeter.classList.add('hidden');
  }

  // Schedule auto-reconnect with countdown
  function scheduleReconnect(delayMs) {
    clearTimeout(reconnectTimer);
    clearInterval(countdownTimer);

    if (isManualDisconnect) return;

    var delay = delayMs || Math.min(1000 * Math.pow(1.5, reconnectAttempts++), 10000);
    reconnectSeconds = Math.ceil(delay / 1000);

    if (lblRetryCountdown) {
      lblRetryCountdown.textContent = 'in ' + reconnectSeconds + 's';
    }

    countdownTimer = setInterval(function () {
      reconnectSeconds--;
      if (reconnectSeconds <= 0) {
        clearInterval(countdownTimer);
        if (lblRetryCountdown) lblRetryCountdown.textContent = 'Connecting...';
      } else {
        if (lblRetryCountdown) lblRetryCountdown.textContent = 'in ' + reconnectSeconds + 's';
      }
    }, 1000);

    reconnectTimer = setTimeout(function () {
      if (currentMode === 'whep') {
        connectWhep();
      } else if (currentMode === 'custom') {
        connectCustomWhep(inputCustomUrl.value.trim());
      }
    }, delay);
  }

  // WHEP Connection Handler (Connecting to OBS GStreamer WebRTC output)
  function connectWhep(customEndpoint) {
    cleanupConnection();
    isManualDisconnect = false;

    var endpoint = customEndpoint || '/whep';
    lblEndpoint.textContent = endpoint;
    setStreamBadge('connecting', 'Connecting...');
    log('Opening WebRTC PeerConnection for WHEP endpoint: ' + endpoint, 'info');

    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    window.__obsWebRTCPeerConnection = pc;

    statPcState.textContent = pc.connectionState;
    statIceState.textContent = pc.iceConnectionState;
    statSignaling.textContent = pc.signalingState;

    pc.onconnectionstatechange = function () {
      statPcState.textContent = pc.connectionState;
      log('PeerConnection state: ' + pc.connectionState, 'info');

      if (pc.connectionState === 'connected') {
        reconnectAttempts = 0;
        setStreamBadge('live', 'LIVE');
        startStatsMonitor();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setStreamBadge('offline', 'DISCONNECTED');
        scheduleReconnect();
      }
    };

    pc.oniceconnectionstatechange = function () {
      statIceState.textContent = pc.iceConnectionState;
      log('ICE connection state: ' + pc.iceConnectionState, 'info');
    };

    pc.onsignalingstatechange = function () {
      statSignaling.textContent = pc.signalingState;
      log('Signaling state: ' + pc.signalingState, 'info');
    };

    // Receive-only video & audio
    pc.addTransceiver('video', { direction: 'recvonly' });
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch (e) {}

    pc.ontrack = function (event) {
      log('WebRTC track received: ' + event.track.kind + ' (' + event.track.id + ')', 'info');
      statTracks.textContent = event.track.kind;

      if (!video.srcObject) {
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
      } else {
        video.srcObject.addTrack(event.track);
      }

      video.play().catch(function (err) {
        log('Video autoplay interrupted: ' + err.message, 'warn');
      });

      setStreamBadge('live', 'LIVE');
      audioVuMeter.classList.remove('hidden');
    };

    video.onloadedmetadata = function () {
      var res = video.videoWidth + 'x' + video.videoHeight;
      statDimensions.textContent = res;
      badgeResolution.textContent = res;
      badgeResolution.classList.remove('hidden');
      log('Video metadata loaded: ' + res, 'info');
    };

    // 1. Create Offer
    pc.createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        log('Sending SDP offer to ' + endpoint + ' (' + pc.localDescription.sdp.length + ' bytes)...', 'info');
        return fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sdp',
            'Accept': 'application/sdp'
          },
          body: pc.localDescription.sdp
        });
      })
      .then(function (response) {
        var contentType = response.headers.get('content-type') || '';
        log('WHEP response status: ' + response.status + ' (' + contentType + ')', 'info');

        // Check if server returned an error
        if (!response.ok) {
          return response.text().then(function (bodyText) {
            // Check if error is backend offline
            if (response.status === 500 || response.status === 502 || response.status === 503) {
              throw new Error('OBS GStreamer stream is offline (daemon not responding on port 8888)');
            }
            throw new Error('WHEP server error ' + response.status + ': ' + bodyText.slice(0, 100));
          });
        }

        // Check if response is HTML (e.g. Nginx fallback, warmup page, or login redirect)
        return response.text().then(function (answerSdp) {
          var trimmed = (answerSdp || '').trim();

          // CRITICAL FIX: Validate SDP format before passing to setRemoteDescription!
          // SDP must start with "v=0" or contain "v=" at line 1.
          if (contentType.includes('text/html') || trimmed.startsWith('<') || !trimmed.startsWith('v=')) {
            log('WHEP endpoint returned HTML warmup/gateway page instead of SDP answer. Stream is offline.', 'warn');
            throw new Error('OBS GStreamer stream is offline (received gateway HTML response instead of SDP answer)');
          }

          log('Valid SDP answer received (' + trimmed.length + ' bytes). Setting remote description...', 'info');
          return pc.setRemoteDescription({
            type: 'answer',
            sdp: trimmed
          });
        });
      })
      .then(function () {
        log('Remote description set successfully. Negotiating ICE candidates...', 'info');
      })
      .catch(function (err) {
        log('Connection notice: ' + err.message, 'error');
        setStreamBadge('offline', 'OFFLINE');

        overlayTitle.textContent = 'OBS WebRTC Stream Offline';
        overlayDesc.textContent = err.message.includes('offline')
          ? 'Waiting for OBS Studio to start streaming via the GStreamer WebRTC output on port 8888.'
          : err.message;

        scheduleReconnect();
      });
  }

  // Built-in WebRTC Loopback Test Pattern Generator
  // Generates dynamic broadcast test bars, audio tone, timestamp, and feeds through a real RTCPeerConnection loopback
  function startTestPattern() {
    cleanupConnection();
    isManualDisconnect = false;

    setStreamBadge('test', 'TEST PATTERN');
    log('Initializing WebRTC Test Pattern Loopback generator...', 'info');

    // 1. Prepare dynamic Canvas animation
    var ctx = testCanvas.getContext('2d');
    var frame = 0;
    var colors = [
      '#ffffff', '#ffea00', '#00e5ff', '#00e676',
      '#e040fb', '#ff1744', '#2979ff', '#212121'
    ];

    function drawTestPattern() {
      var w = testCanvas.width;
      var h = testCanvas.height;

      // Color bars
      var barWidth = w / colors.length;
      for (var i = 0; i < colors.length; i++) {
        ctx.fillStyle = colors[i];
        ctx.fillRect(i * barWidth, 0, barWidth, h * 0.7);
      }

      // Middle gradient bar
      var grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#000000');
      grad.addColorStop(0.5, '#7c3aed');
      grad.addColorStop(1, '#ffffff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, h * 0.7, w, h * 0.1);

      // Bottom section (Dark dashboard)
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, h * 0.8, w, h * 0.2);

      // Bouncing radar / box animation (proves live video decoding)
      var boxX = (Math.sin(frame * 0.05) * 0.5 + 0.5) * (w - 180) + 20;
      ctx.fillStyle = '#6366f1';
      ctx.fillRect(boxX, h * 0.72, 140, 24);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('WEBRTC ACTIVE', boxX + 16, h * 0.72 + 16);

      // Live Timestamp & Clock
      var now = new Date();
      var timeStr = now.toISOString().replace('T', ' ').slice(0, 23) + ' UTC';

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px monospace';
      ctx.fillText('OBS GSTREAMER PLUGIN - TEST PATTERN', 30, h * 0.88);

      ctx.fillStyle = '#38bdf8';
      ctx.font = '20px monospace';
      ctx.fillText(timeStr, 30, h * 0.94);

      // Resolution & FPS indicators
      ctx.fillStyle = '#a78bfa';
      ctx.font = 'bold 18px monospace';
      ctx.fillText('1280x720 @ 30fps | Loopback Mode', w - 420, h * 0.88);
      ctx.fillText('Frame: ' + frame++, w - 420, h * 0.94);

      testAnimationId = requestAnimationFrame(drawTestPattern);
    }

    drawTestPattern();

    // 2. Capture canvas stream
    var canvasStream = testCanvas.captureStream(30);

    // 3. Create Web Audio test oscillator
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        testAudioCtx = new AudioContext();
        var osc = testAudioCtx.createOscillator();
        var gain = testAudioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, testAudioCtx.currentTime); // 440 Hz concert A
        gain.gain.setValueAtTime(0.01, testAudioCtx.currentTime); // Low volume
        osc.connect(gain);
        var dest = testAudioCtx.createMediaStreamDestination();
        gain.connect(dest);
        osc.start();
        dest.stream.getAudioTracks().forEach(function (track) {
          canvasStream.addTrack(track);
        });
      }
    } catch (e) {
      log('Web Audio tone init: ' + e.message, 'info');
    }

    // 4. Setup REAL WebRTC loopback (Local Sender PC -> Local Receiver PC)
    var sender = new RTCPeerConnection();
    var receiver = new RTCPeerConnection();
    loopbackSender = sender;
    pc = receiver;
    window.__obsWebRTCPeerConnection = pc;

    statPcState.textContent = 'connecting';
    statIceState.textContent = 'checking';
    statSignaling.textContent = 'negotiating';

    // Candidate exchange
    sender.onicecandidate = function (e) {
      if (e.candidate) receiver.addIceCandidate(e.candidate);
    };
    receiver.onicecandidate = function (e) {
      if (e.candidate) sender.addIceCandidate(e.candidate);
    };

    receiver.onconnectionstatechange = function () {
      statPcState.textContent = receiver.connectionState;
      if (receiver.connectionState === 'connected') {
        startStatsMonitor();
      }
    };

    receiver.ontrack = function (e) {
      statTracks.textContent = e.track.kind;
      if (!video.srcObject) {
        video.srcObject = e.streams[0] || new MediaStream([e.track]);
      } else {
        video.srcObject.addTrack(e.track);
      }
      video.play().catch(function () {});
      audioVuMeter.classList.remove('hidden');
    };

    // Add canvas tracks to sender
    canvasStream.getTracks().forEach(function (track) {
      sender.addTrack(track, canvasStream);
    });

    // Negotiate offer / answer
    sender.createOffer()
      .then(function (offer) {
        return sender.setLocalDescription(offer);
      })
      .then(function () {
        return receiver.setRemoteDescription(sender.localDescription);
      })
      .then(function () {
        return receiver.createAnswer();
      })
      .then(function (answer) {
        return receiver.setLocalDescription(answer);
      })
      .then(function () {
        return sender.setRemoteDescription(receiver.localDescription);
      })
      .then(function () {
        log('WebRTC Loopback negotiation complete! Test video rendering.', 'info');
        statDimensions.textContent = '1280x720';
        badgeResolution.textContent = '1280x720 @ 30fps';
        badgeResolution.classList.remove('hidden');
      })
      .catch(function (err) {
        log('Test pattern error: ' + err.message, 'error');
      });
  }

  // Custom WHEP Connection
  function connectCustomWhep(url) {
    if (!url) return;
    cleanupConnection();
    log('Connecting to custom WHEP endpoint: ' + url, 'info');
    connectWhep(url);
  }

  // Real-time WebRTC Stats monitor via getStats()
  function startStatsMonitor() {
    if (statsInterval) clearInterval(statsInterval);

    statsInterval = setInterval(function () {
      if (!pc) return;

      pc.getStats().then(function (stats) {
        var currentBytes = 0;
        var currentTimestamp = 0;
        var fps = 0;
        var packetsLost = 0;

        stats.forEach(function (report) {
          if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
            currentBytes = report.bytesReceived || 0;
            currentTimestamp = report.timestamp || Date.now();
            fps = report.framesPerSecond || (video.videoWidth ? 30 : 0);
            packetsLost = report.packetsLost || 0;
          }
        });

        if (prevStatsTimestamp && currentTimestamp > prevStatsTimestamp) {
          var timeDiffSec = (currentTimestamp - prevStatsTimestamp) / 1000;
          var bytesDiff = currentBytes - prevBytesReceived;
          if (bytesDiff > 0 && timeDiffSec > 0) {
            var kbps = Math.round((bytesDiff * 8) / (timeDiffSec * 1000));
            statBitrate.textContent = kbps + ' kbps';
            badgeBitrate.textContent = kbps + ' kbps';
            badgeBitrate.classList.remove('hidden');
          }
        }

        prevBytesReceived = currentBytes;
        prevStatsTimestamp = currentTimestamp;

        if (fps > 0) {
          statFps.textContent = Math.round(fps) + ' fps';
          if (video.videoWidth) {
            badgeResolution.textContent = video.videoWidth + 'x' + video.videoHeight + ' @ ' + Math.round(fps) + 'fps';
          }
        }
        statPacketloss.textContent = String(packetsLost);
      }).catch(function () {});
    }, 1000);
  }

  // UI Event Listeners

  // Mode Selection: OBS Live (WHEP)
  btnModeWhep.addEventListener('click', function () {
    currentMode = 'whep';
    btnModeWhep.className = 'px-3 py-1 rounded font-medium transition-colors bg-indigo-600 text-white shadow-sm flex items-center gap-1.5';
    btnModeTest.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    btnModeCustom.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    badgeSourceMode.textContent = 'WHEP WebRTC';
    customWhepBar.classList.add('hidden');
    connectWhep();
  });

  // Mode Selection: Test Pattern
  btnModeTest.addEventListener('click', function () {
    currentMode = 'test';
    btnModeTest.className = 'px-3 py-1 rounded font-medium transition-colors bg-indigo-600 text-white shadow-sm flex items-center gap-1.5';
    btnModeWhep.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    btnModeCustom.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    badgeSourceMode.textContent = 'TEST PATTERN';
    customWhepBar.classList.add('hidden');
    startTestPattern();
  });

  // Mode Selection: Custom WHEP
  btnModeCustom.addEventListener('click', function () {
    currentMode = 'custom';
    btnModeCustom.className = 'px-3 py-1 rounded font-medium transition-colors bg-indigo-600 text-white shadow-sm flex items-center gap-1.5';
    btnModeWhep.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    btnModeTest.className = 'px-3 py-1 rounded font-medium transition-colors text-slate-400 hover:text-slate-200 flex items-center gap-1.5';
    badgeSourceMode.textContent = 'CUSTOM WHEP';
    customWhepBar.classList.remove('hidden');
    inputCustomUrl.focus();
  });

  btnConnectCustom.addEventListener('click', function () {
    var url = inputCustomUrl.value.trim();
    if (url) {
      connectCustomWhep(url);
    }
  });

  btnSwitchTestPattern.addEventListener('click', function () {
    btnModeTest.click();
  });

  btnReconnectNow.addEventListener('click', function () {
    reconnectAttempts = 0;
    if (currentMode === 'whep') connectWhep();
    else if (currentMode === 'test') startTestPattern();
    else if (currentMode === 'custom') connectCustomWhep(inputCustomUrl.value.trim());
  });

  // Play / Pause toggle
  btnPlayPause.addEventListener('click', function () {
    if (video.paused) {
      video.play().then(function () {
        iconPlay.classList.add('hidden');
        iconPause.classList.remove('hidden');
      });
    } else {
      video.pause();
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    }
  });

  // Mute / Unmute toggle
  btnMute.addEventListener('click', function () {
    video.muted = !video.muted;
    if (video.muted) {
      iconMuted.classList.remove('hidden');
      iconUnmuted.classList.add('hidden');
      volumeSlider.value = 0;
    } else {
      iconMuted.classList.add('hidden');
      iconUnmuted.classList.remove('hidden');
      volumeSlider.value = video.volume || 1;
    }
  });

  // Volume slider
  volumeSlider.addEventListener('input', function (e) {
    var val = parseFloat(e.target.value);
    video.volume = val;
    video.muted = (val === 0);
    if (val === 0) {
      iconMuted.classList.remove('hidden');
      iconUnmuted.classList.add('hidden');
    } else {
      iconMuted.classList.add('hidden');
      iconUnmuted.classList.remove('hidden');
    }
  });

  // Snapshot button
  btnSnapshot.addEventListener('click', function () {
    if (!video.videoWidth || !video.videoHeight) {
      log('Snapshot unavailable: video not active', 'warn');
      return;
    }
    var cap = document.createElement('canvas');
    cap.width = video.videoWidth;
    cap.height = video.videoHeight;
    var cctx = cap.getContext('2d');
    cctx.drawImage(video, 0, 0);

    var link = document.createElement('a');
    link.download = 'obs-stream-snapshot-' + Date.now() + '.png';
    link.href = cap.toDataURL('image/png');
    link.click();
    log('Snapshot downloaded (' + cap.width + 'x' + cap.height + ')', 'info');
  });

  // Picture in Picture
  btnPip.addEventListener('click', function () {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && video) {
      video.requestPictureInPicture().catch(function (e) {
        log('PiP error: ' + e.message, 'warn');
      });
    }
  });

  // Fullscreen
  btnFullscreen.addEventListener('click', function () {
    var wrap = document.getElementById('player-wrap');
    if (!document.fullscreenElement) {
      if (wrap.requestFullscreen) wrap.requestFullscreen();
      else if (video.requestFullscreen) video.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });

  // Stats drawer toggle
  btnToggleStats.addEventListener('click', function () {
    sidePanel.classList.toggle('hidden');
  });

  btnClearLogs.addEventListener('click', function () {
    statusEl.textContent = '';
  });

  // Setup Guide modal
  btnOpenGuide.addEventListener('click', function () {
    modalGuide.classList.remove('hidden');
  });

  btnCloseGuide.addEventListener('click', function () {
    modalGuide.classList.add('hidden');
  });

  btnModalGotIt.addEventListener('click', function () {
    modalGuide.classList.add('hidden');
  });

  modalGuide.addEventListener('click', function (e) {
    if (e.target === modalGuide) modalGuide.classList.add('hidden');
  });

  window.addEventListener('beforeunload', function () {
    isManualDisconnect = true;
    cleanupConnection();
  });

  // Start with default WHEP connection
  connectWhep();
})();
