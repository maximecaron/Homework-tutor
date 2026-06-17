export function pcmToBase64(pcmData: Float32Array): string {
  const buffer = new ArrayBuffer(pcmData.length * 2);
  const view = new DataView(buffer);
  
  for (let i = 0; i < pcmData.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmData[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToPcm(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  const pcm = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  
  return pcm;
}

export class AudioStreamBridge {
  private audioCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private nextStartTime: number = 0;
  private isMuted: boolean = false;

  private activeOutputs: AudioBufferSourceNode[] = [];

  constructor(private ws: WebSocket) {}

  setMuted(muted: boolean) {
     this.isMuted = muted;
     if (this.micStream) {
         this.micStream.getAudioTracks().forEach(t => t.enabled = !muted);
     }
  }

  async startListening(onActive?: () => void) {
     this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
     this.micStream = await navigator.mediaDevices.getUserMedia({
       audio: {
         noiseSuppression: true,
         echoCancellation: true,
         autoGainControl: true,
       }
     });
     
     this.source = this.audioCtx.createMediaStreamSource(this.micStream);
     // Note: ScriptProcessorNode is deprecated but highly supported for explicit raw PCM buffering
     this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
     this.source.connect(this.processor);
     this.processor.connect(this.audioCtx.destination);
     
     let hasEmittedActive = false;

     this.processor.onaudioprocess = (e) => {
       if (!hasEmittedActive && onActive) {
           hasEmittedActive = true;
           onActive();
       }
       if (this.isMuted) return;
       if (this.ws.readyState === WebSocket.OPEN) {
          const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
          this.ws.send(JSON.stringify({ audio: base64 }));
       }
     };

     // Handle output audio setup
     this.nextStartTime = this.audioCtx.currentTime;
  }

  playAudioChunk(base64Audio: string) {
     if (!this.audioCtx) return;
     
     // Auto-resume AudioContext on iOS/Android if it was suspended due to backgrounds/device sleeping
     if (this.audioCtx.state === 'suspended') {
         this.audioCtx.resume().catch(e => console.warn('Auto-resuming AudioContext failed:', e));
     }

     const pcmData = base64ToPcm(base64Audio);
     // The response audio from Gemini is typically 24000 sample rate
     // but the SKILL mentions 24000. Wait, 24000 was the Python script receive rate!
     // Let's create an audio buffer for 24000.
     const audioBuffer = this.audioCtx.createBuffer(1, pcmData.length, 24000);
     audioBuffer.copyToChannel(pcmData, 0);

     const source = this.audioCtx.createBufferSource();
     source.buffer = audioBuffer;
     source.connect(this.audioCtx.destination);
     
     const currentTime = this.audioCtx.currentTime;
     if (this.nextStartTime < currentTime) {
         this.nextStartTime = currentTime;
     }

     source.start(this.nextStartTime);
     this.nextStartTime += audioBuffer.duration;

     this.activeOutputs.push(source);
     source.onended = () => {
         this.activeOutputs = this.activeOutputs.filter(s => s !== source);
     };
  }

  interrupt() {
      // Clear queue and stop playback by rapidly resetting the context path
      this.nextStartTime = 0;
      if (this.audioCtx) {
          this.nextStartTime = this.audioCtx.currentTime;
      }
      
      // Stop all currently playing audio chunks
      for (const source of this.activeOutputs) {
          try {
              source.stop();
              source.disconnect();
          } catch (e) {
              // Ignore errors if source was already stopped
          }
      }
      this.activeOutputs = [];
  }

  stop() {
     if (this.micStream) {
         this.micStream.getTracks().forEach(t => t.stop());
     }
     if (this.source) this.source.disconnect();
     if (this.processor) this.processor.disconnect();
     if (this.audioCtx && this.audioCtx.state !== 'closed') {
         this.audioCtx.close().catch(e => console.warn('Error closing audio context:', e));
     }
  }

  async resume() {
     if (this.audioCtx && this.audioCtx.state === 'suspended') {
         try {
             await this.audioCtx.resume();
             console.log("AudioContext resumed successfully.");
         } catch (e) {
             console.warn("Failed to resume AudioContext dynamically:", e);
         }
     }
  }
}
