/**
 * stem-player.js — Plays separated stems through the existing pitch shifter pipeline.
 * Per-stem GainNodes allow muting/unmuting individual stems.
 * Loaded in offscreen.js.
 */

class StemPlayer {
    constructor(audioContext, pitchShifterNode) {
        this.ctx = audioContext;
        this.shifter = pitchShifterNode;
        this.stems = {};      // { vocals: AudioBuffer, drums: AudioBuffer, ... }
        this.gains = {};      // { vocals: GainNode, ... }
        this.sources = {};    // { vocals: AudioBufferSourceNode, ... }
        this.playing = false;
        this.startOffset = 0;
        this.startTime = 0;
        this.duration = 0;
    }

    /** Decode an Opus WebM Blob into an AudioBuffer */
    async _decodeBlob(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        return this.ctx.decodeAudioData(arrayBuffer);
    }

    /** Load stems from IndexedDB record blobs */
    async loadStems(stemRecord) {
        const names = ['vocals', 'drums', 'bass', 'other'];
        for (const name of names) {
            if (stemRecord[name]) {
                this.stems[name] = await this._decodeBlob(stemRecord[name]);

                if (!this.gains[name]) {
                    this.gains[name] = this.ctx.createGain();
                    this.gains[name].gain.value = 1.0;
                    this.gains[name].connect(this.shifter);
                }
            }
        }
        this.duration = stemRecord.duration || 0;
    }

    /** Start playback of all stems from a given offset (seconds) */
    play(offset = 0) {
        this.stop();
        this.startOffset = offset;
        this.startTime = this.ctx.currentTime;

        for (const [name, buffer] of Object.entries(this.stems)) {
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(this.gains[name]);
            source.start(0, offset);
            this.sources[name] = source;
        }
        this.playing = true;
    }

    /** Stop all playing stems */
    stop() {
        for (const source of Object.values(this.sources)) {
            try { source.stop(); } catch (_) { /* already stopped */ }
        }
        this.sources = {};
        this.playing = false;
    }

    /** Pause: stop and record current position */
    pause() {
        if (this.playing) {
            this.startOffset = this.getCurrentTime();
            this.stop();
        }
    }

    /** Resume from last paused position */
    resume() {
        if (!this.playing) {
            this.play(this.startOffset);
        }
    }

    /** Get current playback time in seconds */
    getCurrentTime() {
        if (!this.playing) return this.startOffset;
        return this.startOffset + (this.ctx.currentTime - this.startTime);
    }

    /** Seek to a specific time */
    seek(time) {
        const wasPlaying = this.playing;
        this.stop();
        this.startOffset = Math.max(0, Math.min(time, this.duration));
        if (wasPlaying) {
            this.play(this.startOffset);
        }
    }

    /** Set gain for a specific stem (0.0 = muted, 1.0 = full) */
    setStemGain(stemName, value) {
        if (this.gains[stemName]) {
            this.gains[stemName].gain.setValueAtTime(value, this.ctx.currentTime);
        }
    }

    /** Toggle a stem on/off. Returns new state (true = on). */
    toggleStem(stemName) {
        if (!this.gains[stemName]) return false;
        const current = this.gains[stemName].gain.value;
        const newValue = current > 0.5 ? 0.0 : 1.0;
        this.gains[stemName].gain.setValueAtTime(newValue, this.ctx.currentTime);
        return newValue > 0.5;
    }

    /** Get current mute state of all stems */
    getStemStates() {
        const states = {};
        for (const [name, gain] of Object.entries(this.gains)) {
            states[name] = gain.gain.value > 0.5;
        }
        return states;
    }

    /** Disconnect all gain nodes from the pitch shifter */
    disconnect() {
        this.stop();
        for (const gain of Object.values(this.gains)) {
            try { gain.disconnect(); } catch (_) { /* already disconnected */ }
        }
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.StemPlayer = StemPlayer;
}
