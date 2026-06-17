/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, BookOpen, AlertCircle, Phone, PhoneOff } from 'lucide-react';
import { AudioStreamBridge } from './lib/audio';

export default function App() {
  const [isServerReady, setIsServerReady] = useState(false);
  const [isCallActive, setIsCallActive] = useState(false);
  const [isAudioStreaming, setIsAudioStreaming] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioBridgeRef = useRef<AudioStreamBridge | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any | null>(null);

  const [transcript, setTranscript] = useState<{
    id: string;
    sender: 'user' | 'tutor';
    text: string;
    timestamp: string;
  }[]>(() => {
    try {
      const saved = localStorage.getItem('homework_tutor_transcript');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom on transcript changes
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  // Persist transcript state changes to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('homework_tutor_transcript', JSON.stringify(transcript));
    } catch (e) {
      console.warn('Failed to save transcript to localStorage:', e);
    }
  }, [transcript]);

  // Screen Wake Lock API implementation
  useEffect(() => {
    let active = true;

    async function requestWakeLock() {
      if (!('wakeLock' in navigator)) return;
      try {
        if (wakeLockRef.current) {
          return; // Already acquired or acquiring
        }
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      } catch (err) {
        console.warn('Screen Wake Lock request failed:', err);
      }
    }

    async function releaseWakeLock() {
      if (wakeLockRef.current) {
        try {
          await wakeLockRef.current.release();
        } catch (err) {
          console.warn('Screen Wake Lock release failed:', err);
        }
        wakeLockRef.current = null;
      }
    }

    if (isCallActive) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    // Recover wake lock when user switches back to the tab
    const handleWakeLockVisibility = () => {
      if (document.visibilityState === 'visible' && isCallActive && active) {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleWakeLockVisibility);

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleWakeLockVisibility);
      releaseWakeLock();
    };
  }, [isCallActive]);

  // Resume Web Audio Context on user input interaction when a call is running
  useEffect(() => {
    if (!isCallActive) return;

    const resumeAudio = () => {
      audioBridgeRef.current?.resume();
    };

    window.addEventListener('click', resumeAudio);
    window.addEventListener('touchstart', resumeAudio);

    return () => {
      window.removeEventListener('click', resumeAudio);
      window.removeEventListener('touchstart', resumeAudio);
    };
  }, [isCallActive]);

  useEffect(() => {
    let isActive = true;
    let ws: WebSocket | null = null;
    let bridge: AudioStreamBridge | null = null;

    const connect = () => {
        if (!isActive) return;

        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
        }

        if (wsRef.current) {
            try {
                wsRef.current.onopen = null;
                wsRef.current.onclose = null;
                wsRef.current.onerror = null;
                wsRef.current.onmessage = null;
                wsRef.current.close();
            } catch (e) {}
            wsRef.current = null;
        }

        if (audioBridgeRef.current) {
            try {
                audioBridgeRef.current.stop();
            } catch (e) {}
            audioBridgeRef.current = null;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/live`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        bridge = new AudioStreamBridge(ws);
        audioBridgeRef.current = bridge;

        let heartbeatInterval: number | null = null;

        ws.onopen = () => {
            heartbeatInterval = window.setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 8000);
        };

        ws.onmessage = (event) => {
           if (!isActive) return;
           const msg = JSON.parse(event.data);
           if (msg.type === 'pong') {
               return;
           }
           if (msg.error) {
               setError(msg.error);
               bridge?.interrupt();
               return;
           }
           if (msg.connected) {
               setError(null);
               setIsServerReady(true);
           }
           if (msg.audio) {
               bridge?.playAudioChunk(msg.audio);
           }
           if (msg.interrupted) {
               bridge?.interrupt();
           }
           if (msg.tutorText) {
               setTranscript(prev => {
                   const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                   if (prev.length === 0) {
                       return [{
                           id: Math.random().toString(36).substring(7),
                           sender: 'tutor',
                           text: msg.tutorText,
                           timestamp: nowStr
                       }];
                   }
                   const last = prev[prev.length - 1];
                   if (last.sender === 'tutor') {
                       const updated = [...prev];
                       updated[updated.length - 1] = {
                           ...last,
                           text: last.text + msg.tutorText
                       };
                       return updated;
                   } else {
                       return [...prev, {
                           id: Math.random().toString(36).substring(7),
                           sender: 'tutor',
                           text: msg.tutorText,
                           timestamp: nowStr
                       }];
                   }
               });
           }
           if (msg.userText) {
               setTranscript(prev => {
                   const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                   if (prev.length === 0) {
                       return [{
                           id: Math.random().toString(36).substring(7),
                           sender: 'user',
                           text: msg.userText,
                           timestamp: nowStr
                       }];
                   }
                   const last = prev[prev.length - 1];
                   if (last.sender === 'user') {
                       const updated = [...prev];
                       updated[updated.length - 1] = {
                           ...last,
                           text: last.text + msg.userText
                       };
                       return updated;
                   } else {
                       return [...prev, {
                           id: Math.random().toString(36).substring(7),
                           sender: 'user',
                           text: msg.userText,
                           timestamp: nowStr
                       }];
                   }
               });
           }
        };
        
        ws.onclose = () => {
           if (heartbeatInterval) clearInterval(heartbeatInterval);
           if (!isActive) return;
           bridge?.stop();
           setIsServerReady(false);
           setIsCallActive(false);
           setIsAudioStreaming(false);
           setIsMuted(false);
           setError('Connection lost. Reconnecting...');
           
           if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
           reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
        };

        ws.onerror = () => {
           if (!isActive) return;
           // Note: onclose will also fire, so we let it handle reconnection
        };
    };

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && isActive) {
            // Re-activate suspended audio contexts which often happens on iOS/Android locks
            audioBridgeRef.current?.resume();

            const currentWs = wsRef.current;
            if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
                connect();
            } else {
                let receivedPong = false;
                const pongHandler = (event: MessageEvent) => {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'pong') {
                            receivedPong = true;
                            currentWs.removeEventListener('message', pongHandler);
                        }
                    } catch (e) {}
                };
                currentWs.addEventListener('message', pongHandler);
                
                try {
                    currentWs.send(JSON.stringify({ type: 'ping' }));
                } catch (e) {
                    connect();
                    return;
                }

                setTimeout(() => {
                    currentWs.removeEventListener('message', pongHandler);
                    if (!receivedPong && isActive) {
                        connect();
                    }
                }, 1500);
            }
        }
    };

    const handleOnline = () => {
        if (isActive) {
            connect();
        }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    connect();

    return () => {
       isActive = false;
       document.removeEventListener('visibilitychange', handleVisibilityChange);
       window.removeEventListener('online', handleOnline);
       if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
       ws?.close();
       bridge?.stop();
    };
  }, []);

  const startCall = async () => {
    if (!audioBridgeRef.current) return;
    setError(null);
    try {
        await audioBridgeRef.current.startListening(() => {
            setIsAudioStreaming(true);
        });
        setIsCallActive(true);
        setIsMuted(false);
        audioBridgeRef.current.setMuted(false);
    } catch (e: any) {
        setError('Failed to access microphone. Please check permissions.');
        setIsCallActive(false);
        setIsAudioStreaming(false);
    }
  };

  const endCall = () => {
    if (!audioBridgeRef.current) return;
    audioBridgeRef.current.stop();
    setIsCallActive(false);
    setIsAudioStreaming(false);
    setIsMuted(false);
  };

  const toggleMute = () => {
    if (!audioBridgeRef.current) return;
    const nextMuted = !isMuted;
    audioBridgeRef.current.setMuted(nextMuted);
    setIsMuted(nextMuted);
  };

  return (
    <div className="min-h-screen bg-[#F9F8F3] flex items-center justify-center p-4 font-sans text-[#4A4439]">
      <div className="max-w-md w-full bg-white rounded-[40px] p-10 shadow-sm border border-[#EBE7D9] flex flex-col items-center justify-center text-center">
        <div className="p-2 w-full text-center flex flex-col items-center">
          <div className="w-16 h-16 bg-[#F2F1EB] border-2 border-[#EBE7D9] rounded-full flex items-center justify-center mb-6">
            <BookOpen className="w-8 h-8 text-[#8E9775]" />
          </div>
          <h1 className="text-2xl font-bold text-[#5A5A40] tracking-tight">
            Homework Tutor
          </h1>
          <p className="mt-2 text-[#8E8B7B] text-sm mb-8">
            A patient, Socratic tutor for all grades. Press the microphone to
            start a session and ask questions naturally.
          </p>

          {error && (
             <div className="w-full mb-6 p-4 bg-[#F9F8F3] text-[#E28F83] border border-[#EBE7D9] text-sm rounded-2xl flex items-start text-left">
                <AlertCircle className="w-5 h-5 mr-3 shrink-0 mt-0.5" />
                <p>{error}</p>
             </div>
          )}

          <div className="relative flex items-center justify-center gap-6">
             {isCallActive && !isMuted && (
                <div className="absolute inset-0 bg-[#8E9775] rounded-full blur-xl opacity-30 animate-pulse"></div>
             )}
             
             {!isCallActive ? (
                 <button
                   onClick={startCall}
                   disabled={!isServerReady}
                   className={`relative z-10 w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 shadow-md bg-[#8E9775] hover:bg-[#7D8566] text-white shadow-[#8E9775]/20 ${!isServerReady ? 'opacity-50 scale-95 cursor-not-allowed' : 'hover:scale-105 active:scale-95'}`}
                 >
                    <Phone className="w-10 h-10" />
                 </button>
             ) : (
                 <>
                     <button
                       onClick={endCall}
                       className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-md bg-[#E28F83] hover:bg-[#D47E72] text-white shadow-[#E28F83]/20 hover:scale-105 active:scale-95"
                     >
                       <PhoneOff className="w-8 h-8" />
                     </button>
                     <button
                       onClick={toggleMute}
                       className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-md ${
                         isMuted 
                           ? 'bg-[#A8A492] hover:bg-[#8E8B7B] text-white shadow-[#A8A492]/20' 
                           : 'bg-[#8E9775] hover:bg-[#7D8566] text-white shadow-[#8E9775]/20'
                       } hover:scale-105 active:scale-95`}
                     >
                        {isMuted ? (
                          <MicOff className="w-8 h-8" />
                        ) : (
                          <Mic className="w-8 h-8" />
                        )}
                     </button>
                 </>
             )}
          </div>
          
          <div className="mt-8 text-sm font-semibold h-16 flex items-start justify-center">
             {!isServerReady ? (
               <span className="text-[#8E9775] animate-pulse">Connecting...</span>
             ) : isCallActive ? (
               <div className="flex flex-col items-center gap-4">
                  {!isMuted ? (
                      isAudioStreaming ? (
                          <>
                            <div className="flex items-end gap-1.5 h-8">
                              <div className="w-1.5 h-4 bg-[#8E9775] rounded-full opacity-40 animate-pulse"></div>
                              <div className="w-1.5 h-8 bg-[#8E9775] rounded-full opacity-60 animate-pulse delay-75"></div>
                              <div className="w-1.5 h-6 bg-[#8E9775] rounded-full animate-pulse delay-150"></div>
                              <div className="w-1.5 h-7 bg-[#8E9775] rounded-full opacity-80 animate-pulse delay-300"></div>
                              <div className="w-1.5 h-5 bg-[#8E9775] rounded-full opacity-50 animate-pulse delay-200"></div>
                            </div>
                            <span className="text-[#8E9775]">"I'm listening..."</span>
                          </>
                      ) : (
                          <span className="text-[#8E9775] animate-pulse">Starting stream...</span>
                      )
                  ) : (
                      <span className="text-[#A8A492] mt-4">Microphone muted</span>
                  )}
               </div>
             ) : (
               <span className="text-[#A8A492]">Tap phone icon to start session</span>
             )}
          </div>

          {/* Transcript Area */}
          <div className="w-full mt-6 pt-6 border-t border-[#EBE7D9] text-left">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-bold text-[#8E8B7B] tracking-wider uppercase">
                Conversation Transcript
              </h2>
              {transcript.length > 0 && (
                <button
                  onClick={() => setTranscript([])}
                  className="text-xs text-[#E28F83] hover:text-[#D47E72] font-semibold transition duration-150 cursor-pointer"
                >
                  Clear History
                </button>
              )}
            </div>
            
            <div className="max-h-60 overflow-y-auto pr-1 flex flex-col gap-3 scrollbar-thin scrollbar-thumb-[#EBE7D9] scrollbar-track-transparent">
              {transcript.length === 0 ? (
                <p className="text-center py-8 text-xs text-[#A8A492] italic">
                  Speech-to-text transcript will appear here in real-time as you chat.
                </p>
              ) : (
                transcript.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col w-full ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`p-3 rounded-2xl text-[13px] leading-relaxed max-w-[85%] shadow-sm ${
                        msg.sender === 'user'
                          ? 'bg-[#8E9775] text-white rounded-br-none text-left'
                          : 'bg-[#F2F1EB] text-[#4A4439] border border-[#EBE7D9] rounded-bl-none text-left'
                      }`}
                    >
                      {msg.text}
                    </div>
                    <span className="text-[9px] text-[#A8A492] mt-1 px-1">{msg.sender === 'user' ? 'You' : 'Tutor'} • {msg.timestamp}</span>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
