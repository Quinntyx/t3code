# Voice

Voice lets you run T3 Code by talking or typing. It sees the threads in every environment
this device is connected to, and it can start threads, send them messages, interrupt or
stop them, and answer their pending requests, with the same permissions as the rest of
the app.

## Set up

Add a Gemini API key in **Settings → Voice** on each device you use. The key stays on
that device, not on your T3 server: desktop keeps it in the operating system keyring and
refuses to store it unencrypted, mobile keeps it in the iOS Keychain or Android Keystore,
and web keeps it in browser storage, where other scripts on the same origin can read it.
Conversation and tool results go directly to Gemini, and Gemini API charges may apply.
Remove the key to turn Voice off.

## Use

On web and desktop, open Voice from a right panel's add menu, the command palette, or its
keyboard shortcut. It follows you between threads. On mobile, open it from a thread's
toolbar or details, or from the command palette; it opens beside the thread on tablets
and as a sheet on phones.

Typing works without a microphone; opening Voice never requests microphone access, only
**Talk** does. Mute stops capture, stop speaking discards the current spoken reply, and
closing Voice ends the connection. On mobile, leaving the app or switching audio output
ends it too. Reconnecting is always explicit.

## Notifications from threads

Agents can tell Voice about their work with the `notify_voice` tool. Each notification
is recorded in that thread's timeline, so a successful call means it was recorded, not
that anyone heard it. A connected Voice speaks notifications for threads this device can
see, and catches up on recent ones when it opens.
