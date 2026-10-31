# TeamSpeak Realtime Backend

Gateway Socket.IO para presencia de participantes, chat en tiempo real y señalización WebRTC.

## Eventos

| Dirección | Evento | Payload mínimo |
| --- | --- | --- |
| cliente → servidor | `room:join` | `{ roomId }` |
| cliente → servidor | `room:leave` | — |
| cliente → servidor | `chat:send` | `{ text }` |
| servidor → cliente | `room:joined` | `{ roomId }` |
| servidor → cliente | `room:participant-joined` | `{ userId }` |
| servidor → cliente | `room:participant-left` | `{ userId }` |
| bidireccional | `webrtc:offer`, `webrtc:answer`, `webrtc:ice-candidate` | señal WebRTC |
| bidireccional | `media:state`, `screen:state` | estado del usuario |

La conexión requiere `socket.handshake.auth.token` con un Firebase ID token. La persistencia del historial queda en `backend-api`.
