# PS4 Discord WebUI

Simple Python FastAPI web UI to browse guilds/channels and send messages using a Discord token placed in `config.json`.

## Setup

1. Create a virtual environment and install requirements:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Copy `config.json.example` to `config.json` and add your Discord token:

```json
{
  "token": "YOUR_DISCORD_TOKEN"
}
```

3. Run the app:

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

4. Open `http://<your-local-ip>:8000` on your PS4 browser. Replace `<your-local-ip>` with your computer's local IP address.

## Notes
- This proxies Discord REST API requests from the server using the token in `config.json`.
> **⚠️ Warning:** Using user tokens may violate Discord's Terms of Service. Prefer bot tokens and invite the bot to guilds if possible.
- Every message sent from this client includes an invisible character (Unicode U+200B ZERO WIDTH SPACE) at the end. This allows other WebUI clients to detect if a message was sent using this client.
- Twemoji is now proxied from the PC, so it is no longer requested by the PS4 itself, in case the PS4 does not have internet access.