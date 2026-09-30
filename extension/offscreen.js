'use strict';

const _log = (...args) => console.log('%c[KS:offscreen]', 'color:#a855f7;font-weight:bold', ...args);
const _warn = (...args) => console.warn('%c[KS:offscreen]', 'color:#f59e0b;font-weight:bold', ...args);
const _err = (...args) => console.error('%c[KS:offscreen]', 'color:#ef4444;font-weight:bold', ...args);

let audioContext = null;
let pitchShifterNode = null;
let stream = null;
let mediaStreamSource = null;
let stemQueue = null;
let stemPlayer = null;
let stemModeActive = false;

// ─── Tab Audio Recording ───
let recordingDestination = null;
let mediaRecorder = null;
let recordingChunks = [];
let recordingSampleRate = 44100;
let isRecording = false;

async function startCapture(streamId, settings) {
    _log('startCapture, media:', settings.media);
    audioContext = new AudioContext({sampleRate: 44100});

    await audioContext.audioWorklet.addModule('pitch-shifter-processor.js');
    pitchShifterNode = new AudioWorkletNode(audioContext, 'pitch-shifter-processor', {
        outputChannelCount: [2]
    });

    if (settings.media) {
        pitchShifterNode.port.postMessage({hasMedia: true});
    } else {
        pitchShifterNode.port.postMessage({hasMedia: false});
    }

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });

        mediaStreamSource = audioContext.createMediaStreamSource(stream);
        mediaStreamSource.connect(pitchShifterNode);
        pitchShifterNode.connect(audioContext.destination);
        await audioContext.resume();

        _log('capture started, audioContext state:', audioContext.state);
        chrome.runtime.sendMessage({type: 'offscreen-ready', settings: settings});
    } catch (err) {
        _err('capture error:', err.message);
        chrome.runtime.sendMessage({type: 'offscreen-capture-failure'});
    }
}

function stopCapture() {
    _log('stopCapture');
    if (stream) {
        stream.getAudioTracks().forEach(t => t.stop());
        stream = null;
    }
    if (stemPlayer) {
        stemPlayer.disconnect();
        stemPlayer = null;
    }
    stemModeActive = false;
    mediaStreamSource = null;
    if (audioContext) {
        audioContext.suspend();
        audioContext = null;
    }
    pitchShifterNode = null;
}

function syncAudio() {
    if (audioContext && pitchShifterNode) {
        audioContext.suspend().then(() => {
            pitchShifterNode.port.postMessage({reset: true});
            audioContext.resume();
        });
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target !== 'offscreen') return;
    _log('msg:', msg.type, msg);

    switch (msg.type) {
        case 'start-capture':
            startCapture(msg.streamId, msg.settings);
            break;
        case 'stop-capture':
            stopCapture();
            break;
        case 'sync-audio':
            syncAudio();
            break;
        case 'set-rate':
            if (pitchShifterNode) {
                pitchShifterNode.port.postMessage({rate: msg.rate});
            }
            break;
        case 'set-pitch':
            if (pitchShifterNode) {
                pitchShifterNode.port.postMessage({pitchShift: msg.pitchShift});
            }
            break;
        case 'set-has-media':
            if (pitchShifterNode) {
                pitchShifterNode.port.postMessage({hasMedia: msg.hasMedia});
            }
            break;
        case 'stem-separate':
            handleStemSeparate(msg);
            break;
        case 'stem-toggle':
            handleStemToggle(msg.stem);
            break;
        case 'stem-activate':
            handleStemActivate(msg.url);
            break;
        case 'stem-deactivate':
            handleStemDeactivate();
            break;
        case 'stem-record-start':
            startRecording();
            break;
        case 'stem-record-stop':
            stopRecording(msg.title || '', msg.tabId);
            break;
    }
});

// ─── Tab Audio Recording for Stem Separation ───

function startRecording() {
    if (!audioContext || !mediaStreamSource) {
        _warn('Cannot record: no active tab capture');
        chrome.runtime.sendMessage({ target: 'background', type: 'stem-error', message: 'No active audio capture' });
        return;
    }
    if (isRecording) return;

    isRecording = true;
    recordingChunks = [];
    recordingSampleRate = audioContext.sampleRate;

    // Create a MediaStreamDestination to tap the tab audio via MediaRecorder
    recordingDestination = audioContext.createMediaStreamDestination();
    mediaStreamSource.connect(recordingDestination);

    mediaRecorder = new MediaRecorder(recordingDestination.stream, {
        mimeType: 'audio/webm;codecs=opus',
        audioBitsPerSecond: 256000
    });
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunks.push(e.data);
    };
    mediaRecorder.start(1000); // collect data every second

    _log('Recording started via MediaRecorder');
    chrome.runtime.sendMessage({ target: 'background', type: 'stem-recording-started' });
}

async function stopRecording(title, tabId) {
    if (!isRecording) return;
    isRecording = false;

    // Stop MediaRecorder and wait for final data
    const recordingDone = new Promise(resolve => {
        mediaRecorder.onstop = () => resolve();
    });
    mediaRecorder.stop();
    await recordingDone;

    // Disconnect recording tap
    if (recordingDestination) {
        try { mediaStreamSource.disconnect(recordingDestination); } catch (_) {}
        recordingDestination = null;
    }
    mediaRecorder = null;

    if (recordingChunks.length === 0) {
        _warn('Recording is empty, nothing to separate');
        chrome.runtime.sendMessage({ target: 'background', type: 'stem-error', message: 'No audio was recorded' });
        return;
    }

    // Decode the recorded WebM/Opus blob into raw PCM
    const blob = new Blob(recordingChunks, { type: 'audio/webm;codecs=opus' });
    recordingChunks = [];
    _log('Recording blob size:', blob.size, 'bytes');

    const arrayBuffer = await blob.arrayBuffer();
    const offlineCtx = new OfflineAudioContext(2, 1, recordingSampleRate);
    const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);

    const length = audioBuffer.length;
    const leftChannel = new Float32Array(length);
    const rightChannel = new Float32Array(length);
    leftChannel.set(audioBuffer.getChannelData(0));
    if (audioBuffer.numberOfChannels >= 2) {
        rightChannel.set(audioBuffer.getChannelData(1));
    } else {
        rightChannel.set(leftChannel);
    }

    const duration = audioBuffer.duration;
    _log('Recording stopped:', duration.toFixed(1), 'seconds,', length, 'samples');

    const recordId = 'recorded:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);

    chrome.runtime.sendMessage({ target: 'background', type: 'stem-recording-stopped' });

    getQueue().addFromBuffer(leftChannel, rightChannel, recordingSampleRate, duration, recordId, title, tabId);
}

// ─── Stem Separation ───

function getQueue() {
    if (!stemQueue) stemQueue = new StemQueue();
    return stemQueue;
}

async function handleStemSeparate(msg) {
    // Check cache first
    const cached = await StemDB.getStems(msg.url);
    if (cached) {
        chrome.runtime.sendMessage({
            target: 'background',
            type: 'stem-ready',
            url: msg.url,
            tabId: msg.tabId
        });
        return;
    }
    getQueue().add(msg.url, msg.title || '', msg.tabId);
}

function handleStemToggle(stemName) {
    if (stemPlayer && stemModeActive) {
        const isActive = stemPlayer.toggleStem(stemName);
        chrome.runtime.sendMessage({
            target: 'background',
            type: 'stem-states',
            states: stemPlayer.getStemStates()
        });
    }
}

async function handleStemActivate(url) {
    _log('stem activate, url:', url?.slice(0, 80));
    if (!audioContext || !pitchShifterNode) {
        _warn('stem activate aborted: no audioContext or pitchShifterNode');
        return;
    }

    const record = await StemDB.getStems(url);
    if (!record) return;

    // Create stem player and load stems
    stemPlayer = new StemPlayer(audioContext, pitchShifterNode);
    await stemPlayer.loadStems(record);

    // Disconnect tab capture source, keep pitch shifter connected to destination
    if (mediaStreamSource) {
        try { mediaStreamSource.disconnect(pitchShifterNode); } catch (_) {}
    }

    stemModeActive = true;
    stemPlayer.play(0);

    chrome.runtime.sendMessage({
        target: 'background',
        type: 'stem-states',
        states: stemPlayer.getStemStates()
    });
}

function handleStemDeactivate() {
    if (stemPlayer) {
        stemPlayer.disconnect();
        stemPlayer = null;
    }
    stemModeActive = false;

    // Reconnect tab capture source
    if (mediaStreamSource && pitchShifterNode) {
        mediaStreamSource.connect(pitchShifterNode);
    }
}
