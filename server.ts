import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";

// Read the prompt file
const promptPath = path.join(process.cwd(), "src/prompt.ts");
const SYSTEM_INSTRUCTION = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf-8") : "You are a helpful tutor.";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Add route to handle health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server, path: "/live" });

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  wss.on("connection", async (clientWs) => {
    let session: any = null;

    try {
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;
            
            const serverContent = message.serverContent as any;
            if (!serverContent) return;

            const audio = serverContent.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ audio }));
            }

            // Capture model text (tutor responses)
            const modelParts = serverContent.modelTurn?.parts;
            if (modelParts) {
              let tutorText = "";
              for (const part of modelParts) {
                if (part.text) {
                  tutorText += part.text;
                }
              }
              if (tutorText) {
                clientWs.send(JSON.stringify({ tutorText }));
              }
            }

            // Capture user text transcribed from user's voice inputs
            const userParts = serverContent.userTurn?.parts;
            if (userParts) {
              let userText = "";
              for (const part of userParts) {
                if (part.text) {
                  userText += part.text;
                }
              }
              if (userText) {
                clientWs.send(JSON.stringify({ userText }));
              }
            }

            if (serverContent.interrupted) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ connected: true }));
      }

      clientWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: "pong" }));
            }
            return;
          }
          if (msg.audio) {
            try {
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            } catch (e) {
              console.error("Error sending input", e);
            }
          }
        } catch (e) {
          console.error("Client message processing error", e);
        }
      });

      clientWs.on("close", () => {
        if (session) {
          session.close();
        }
      });
      
      clientWs.on("error", (err) => {
         console.error("WebSocket client error", err);
         if (session) session.close();
      });

    } catch (e: any) {
      console.error("Error connecting to Gemini Live", e);
      if (!process.env.GEMINI_API_KEY) {
        clientWs.send(JSON.stringify({ error: "GEMINI_API_KEY is not configured on the server. If this is a published app, ensure the API key is accessible." }));
      } else {
        clientWs.send(JSON.stringify({ error: "Failed to connect to Gemini Live API: " + (e.message || "Unknown error") }));
      }
      setTimeout(() => clientWs.close(), 500);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }
}

startServer();
