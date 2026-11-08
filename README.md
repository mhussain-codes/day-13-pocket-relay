# Pocket Relay — Day 13

Write a message on your phone, then open the same short chat link on a laptop to find it saved there. Pocket Relay creates a separate link for each person or topic, so no messaging app is needed on the computer.

## How it works

1. Start the Node.js app on a host with a persistent writable directory.
2. Create a chat link and copy it from your phone.
3. Open that link on your laptop, or type the short code shown beside it.
4. Messages sync to the same room and remain available for 30 days after the latest message.

Each room has a separate 10-character code. The server encrypts its local data file at rest using an app-generated key stored outside the public folder. There are no third-party runtime dependencies.

## Run it

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://localhost:3000`. The app stores encrypted room data in `data/`; keep this directory writable and back it up together with `data/storage.key`. If you set `CHAT_DATA_DIR`, put it in a persistent directory outside the web root.

## Host it

This app needs a Node.js host and persistent storage; GitHub Pages alone cannot save messages between devices. On a Node.js hosting plan, connect this repository, select Node.js 20+, and set the start command to `npm start` (or entry file `server.js`). Make sure the application can write its data directory and that HTTPS is enabled before sharing links.

On Hostinger, use hPanel's Node.js application deployment for your domain or subdomain. Keep the encrypted `data/` directory persistent across app restarts and deployments. The app listens on the `PORT` environment variable supplied by the host.

## Privacy and limits

The chat code is a bearer link: anyone who has it can read and add messages. Messages are encrypted at rest on the host, but they are not end-to-end encrypted; the server can decrypt them to display a chat. Do not use this for passwords, payment details, authentication codes, or highly sensitive conversations. Share links carefully. Chats expire after 30 days without a new message; each room accepts up to 500 messages of 5,000 characters each.

## Built with

HTML, CSS, browser JavaScript, and Node.js built-in modules. MIT License.
