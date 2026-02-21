from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import aiohttp
import json
import pathlib
from urllib.parse import quote
import time

app = FastAPI()
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

CONFIG_PATH = pathlib.Path("config.json")
if CONFIG_PATH.exists():
    try:
        _cfg = json.loads(CONFIG_PATH.read_text())
        TOKEN = _cfg.get("token", "")
    except Exception:
        TOKEN = ""
else:
    TOKEN = ""

DISCORD_API_BASE = "https://discord.com/api/v10"

# Simple in-memory cache for guilds to avoid repeated slow requests
GUILDS_CACHE = {"data": None, "ts": 0}
GUILDS_TTL = 30  # seconds

def auth_headers():
    return {"Authorization": TOKEN, "User-Agent": "ps4discord-webui/1.0"}

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "token_present": bool(TOKEN)})

async def discord_get(path: str):
    if not TOKEN:
        raise HTTPException(status_code=400, detail="Missing token in config.json")
    url = f"{DISCORD_API_BASE}{path}"
    async with aiohttp.ClientSession() as sess:
        async with sess.get(url, headers=auth_headers()) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise HTTPException(status_code=resp.status, detail=text)
            return await resp.json()

async def discord_post(path: str, payload: dict):
    if not TOKEN:
        raise HTTPException(status_code=400, detail="Missing token in config.json")
    url = f"{DISCORD_API_BASE}{path}"
    async with aiohttp.ClientSession() as sess:
        async with sess.post(url, headers={**auth_headers(), "Content-Type": "application/json"}, json=payload) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise HTTPException(status_code=resp.status, detail=text)
            # some endpoints return empty 204; try json but fallback
            try:
                return await resp.json()
            except Exception:
                return {"ok": True}


async def discord_put(path: str):
    if not TOKEN:
        raise HTTPException(status_code=400, detail="Missing token in config.json")
    url = f"{DISCORD_API_BASE}{path}"
    async with aiohttp.ClientSession() as sess:
        async with sess.put(url, headers=auth_headers()) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise HTTPException(status_code=resp.status, detail=text)
            try:
                return await resp.json()
            except Exception:
                return {"ok": True}


async def discord_delete(path: str):
    if not TOKEN:
        raise HTTPException(status_code=400, detail="Missing token in config.json")
    url = f"{DISCORD_API_BASE}{path}"
    async with aiohttp.ClientSession() as sess:
        async with sess.delete(url, headers=auth_headers()) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise HTTPException(status_code=resp.status, detail=text)
            try:
                return await resp.json()
            except Exception:
                return {"ok": True}

@app.get("/api/guilds")
async def api_guilds():
    now = time.time()
    if GUILDS_CACHE["data"] and (now - GUILDS_CACHE["ts"] < GUILDS_TTL):
        return GUILDS_CACHE["data"]
    data = await discord_get("/users/@me/guilds")
    GUILDS_CACHE["data"] = data
    GUILDS_CACHE["ts"] = now
    return data


@app.post("/api/guilds/refresh")
async def api_refresh_guilds():
    # force refresh
    data = await discord_get("/users/@me/guilds")
    GUILDS_CACHE["data"] = data
    GUILDS_CACHE["ts"] = time.time()
    return {"ok": True}


@app.get("/api/me")
async def api_me():
    return await discord_get("/users/@me")


@app.get("/api/guilds/{guild_id}/members/{user_id}")
async def api_get_member(guild_id: str, user_id: str):
    return await discord_get(f"/guilds/{guild_id}/members/{user_id}")

@app.get("/api/guilds/{guild_id}/channels")
async def api_guild_channels(guild_id: str):
    return await discord_get(f"/guilds/{guild_id}/channels")

@app.get("/api/channels/{channel_id}/messages")
async def api_channel_messages(channel_id: str, limit: int = 50, after: str | None = None):
    q = f"?limit={limit}"
    if after:
        q += f"&after={after}"
    return await discord_get(f"/channels/{channel_id}/messages{q}")


@app.put("/api/channels/{channel_id}/messages/{message_id}/reactions/{emoji}")
async def api_add_reaction(channel_id: str, message_id: str, emoji: str):
    # emoji must be URL-encoded; server will quote to be safe
    e = quote(emoji, safe='')
    return await discord_put(f"/channels/{channel_id}/messages/{message_id}/reactions/{e}/@me")


@app.delete("/api/channels/{channel_id}/messages/{message_id}/reactions/{emoji}")
async def api_remove_reaction(channel_id: str, message_id: str, emoji: str):
    e = quote(emoji, safe='')
    return await discord_delete(f"/channels/{channel_id}/messages/{message_id}/reactions/{e}/@me")

@app.post("/api/channels/{channel_id}/messages")
async def api_send_message(channel_id: str, payload: dict):
    content = payload.get("content", "")
    if content is None:
        raise HTTPException(status_code=400, detail="Empty content")
    body = {"content": content}
    # support replying to a message: payload may include 'reply_to' (message id)
    reply_to = payload.get("reply_to") or payload.get("message_reference")
    if reply_to:
        # if reply_to is dict with ids, pass through; if string, assume message id
        if isinstance(reply_to, dict):
            body["message_reference"] = reply_to
        else:
            body["message_reference"] = {"message_id": str(reply_to), "channel_id": channel_id}
        # by default allow Discord to mention the replied user; frontend can override
        body.setdefault("allowed_mentions", {"replied_user": True})
    return await discord_post(f"/channels/{channel_id}/messages", body)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
