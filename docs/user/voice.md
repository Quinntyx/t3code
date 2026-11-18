# Voice on web and desktop

Voice lets you run T3 Code by talking or typing. It sees the threads in every environment
this window is connected to, and it can start threads, send them messages, interrupt or
stop them, and answer their pending requests, with the same permissions as the rest of
the app. To dictate text into a draft instead, see [Voice input](./voice-input.md).

## Set up

Add a Gemini API key under **Voice panel** in **Settings → Voice**. The key stays on this
device, not on your T3 server: desktop keeps it in the operating system keyring and refuses
to store it unencrypted, and web keeps it in browser storage, where other scripts on the
same origin can read it. Conversation and tool results go directly to Gemini, and Gemini
API charges may apply. Remove the key to turn Voice off.

## Use

Open Voice from a right panel's add menu, the command palette, or its keyboard shortcut.
Voice belongs to the window rather than to one thread: its tab appears in every thread's
right panel while it is open, and switching threads keeps the same conversation and
connection. Selecting another tab shows that thread's own surface without closing Voice;
selecting Voice again returns to it. Typing works without a microphone; opening Voice never
requests microphone access, only **Talk** does, using the microphone chosen under **Input**
on the same settings page. Mute stops capture, stop speaking discards the current spoken
reply, and closing the Voice tab ends the connection. Reconnecting is always explicit.

## Notifications from threads

Agents can tell Voice about their work with the `notify_voice` tool. Each notification
is recorded in that thread's timeline, so a successful call means it was recorded, not
that anyone heard it. A connected Voice speaks notifications for threads this window can
see, and catches up on recent ones when it opens.

Mobile support is not included yet.
