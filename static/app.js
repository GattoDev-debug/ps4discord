async function api(path, opts={}){
  const res = await fetch(path, opts);
  if(!res.ok){
    const t = await res.text();
    throw new Error(t||res.statusText);
  }
  return res.json();
}

const guildsEl = document.getElementById('guilds');
const channelsEl = document.getElementById('channels');
const messagesEl = document.getElementById('messages');
const sendForm = document.getElementById('sendForm');
const currentChannelName = document.getElementById('currentChannelName');
const channelInfo = document.getElementById('channelInfo');
let currentChannel = null;
let sending = false;
let lastSent = {content:'', ts:0};
let pollId = null;
let lastMessageId = null;
let currentUser = null;
const channelHidden = {};
const MAX_MESSAGES = 200;
let replyTarget = null; // {messageId, author, snippet, guildId}

const replyPreviewEl = document.getElementById('replyPreview');
const replyMetaEl = document.getElementById('replyMeta');
const cancelReplyBtn = document.getElementById('cancelReply');
if(cancelReplyBtn) cancelReplyBtn.addEventListener('click', ()=>{
  replyTarget = null;
  if(replyPreviewEl) replyPreviewEl.style.display = 'none';
});

function isNearBottom(el, threshold=150){
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function scrollToBottom(){
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Prevent user from scrolling up; keep view pinned to bottom
messagesEl.addEventListener('scroll', (e)=>{
  if(e.isTrusted){
    // user-initiated scroll -> force back to bottom
    scrollToBottom();
  }
});

function fmtTime(iso){
  try{ const d = new Date(iso); return d.toLocaleString(); }catch(e){return iso}
}

// Remove or replace emoji characters so PS4 shows a placeholder instead

function sanitizeUrl(url){
  try{
    const u = url.trim();
    if(/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
    return '#';
  }catch(e){return '#'}
}

function renderMarkdown(text){
  if(!text) return text;
  // operate on string that may already contain some HTML (mentions). We'll perform safe markdown replacements.
  let out = text;
  // code block ``` ```
  out = out.replace(/```(?:[a-zA-Z0-9]+\n)?([\s\S]*?)```/g, function(_,code){
    return `<pre><code>${code}</code></pre>`;
  });
  // inline code `code`
  out = out.replace(/`([^`]+)`/g, function(_,c){ return `<code>${c}</code>`; });
  // bold **text** or __text__
  out = out.replace(/(\*\*|__)(.*?)\1/g, function(_,__,t){ return `<strong>${t}</strong>`; });
  // strikethrough ~~text~~
  out = out.replace(/~~(.*?)~~/g, function(_,t){ return `<del>${t}</del>`; });
  // italic *text* or _text_
  out = out.replace(/(?<!\*)\*(?!\*)(.*?)\*(?!\*)/g, function(_,t){ return `<em>${t}</em>`; });
  out = out.replace(/(?<!_)_(?!_)(.*?)_(?!_)/g, function(_,t){ return `<em>${t}</em>`; });
  // links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_,label,url){
    const href = sanitizeUrl(url);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return out;
}

async function loadGuilds(){
  try{
    guildsEl.innerHTML = '<li class="loading"><span class="spinner"></span>Loading guilds...</li>';
    // fetch current user first to detect pings
    try{ currentUser = await api('/api/me'); }catch(e){ currentUser = null }
    const guilds = await api('/api/guilds');
    guildsEl.innerHTML = '';
    guilds.forEach(g=>{
      const li = document.createElement('li');
      li.textContent = g.name || g.id;
      li.onclick = ()=>loadChannels(g.id);
      guildsEl.appendChild(li);
    });
  }catch(e){
    guildsEl.innerHTML = '<li style="color:#ffb4b4">'+e.message+'</li>';
  }
}

document.getElementById('refreshGuilds').addEventListener('click', async ()=>{
  try{
    document.getElementById('refreshGuilds').disabled = true;
    await api('/api/guilds/refresh', {method:'POST'});
    await loadGuilds();
  }catch(e){
    alert('Refresh failed: '+e.message);
  }finally{
    document.getElementById('refreshGuilds').disabled = false;
  }
});

async function loadChannels(guildId){
  try{
    const chans = await api(`/api/guilds/${guildId}/channels`);
    channelsEl.innerHTML = '';
    chans.filter(c=>c.type===0 || c.type===5 || c.type===2).forEach(c=>{
      const li = document.createElement('li');
      li.textContent = (c.type===0? '# ':'') + (c.name||c.id);
      li.dataset.channelId = c.id;
      li.classList.toggle('hidden', !!channelHidden[c.id]);
      li.onclick = ()=>selectChannel(c.id, c.name);
      channelsEl.appendChild(li);
    });
  }catch(e){
    channelsEl.innerHTML = '<li style="color:#ffb4b4">'+e.message+'</li>';
  }
}

async function selectChannel(channelId, channelName){
  currentChannel = channelId;
  currentChannelName.textContent = channelName || `#${channelId}`;
  channelInfo.textContent = `Channel: ${channelId}`;
  await loadMessages(channelId);
  startPolling(channelId);
}

async function loadMessages(channelId){
  try{
    const msgs = await api(`/api/channels/${channelId}/messages?limit=50`);
    messagesEl.innerHTML = '';
    // show oldest -> newest
    const missingMembers = new Map();
    msgs.reverse().forEach(m=>{
      const d = document.createElement('div');
      d.className = 'msg';
      d.dataset.authorId = m.author?.id || '';
      d.dataset.messageId = m.id || '';
      d.dataset.guildId = m.guild_id || '';
      // display name prefers member nick -> global_name -> username
      let displayName = (m.member && m.member.nick) || (m.author && (m.author.global_name || m.author.username)) || null;
      if(!displayName && m.guild_id && m.author && m.author.id){
        // mark for later lookup
        const key = `${m.guild_id}:${m.author.id}`;
        missingMembers.set(key, {guildId: m.guild_id, userId: m.author.id});
        displayName = m.author && (m.author.global_name || m.author.username) || 'unknown';
      }
      displayName = displayName || 'unknown';
      const author = `<div class="meta"><strong>${displayName}</strong> • ${fmtTime(m.timestamp||m.id)}</div>`;
      let replyHtml = '';
      if(m.referenced_message){
        const ref = m.referenced_message;
        const refDisplay = (ref.member && ref.member.nick) || (ref.author && (ref.author.global_name || ref.author.username)) || 'unknown';
        const refContent = (ref.content||'').replace(/</g,'&lt;');
        replyHtml = `<div class="reply"><div class="reply-author">Reply to ${refDisplay}</div><div class="reply-snippet">${refContent}</div></div>`;
      }
      // replace mentions with markers, then escape the rest to avoid breaking inserted HTML
      let raw = (m.content||'');
      const mentionHtml = [];
      if(m.mentions && m.mentions.length){
        m.mentions.forEach((u,i)=>{
          const name = (u.username || u.global_name) || u.id;
          const marker = `__MENTION_${i}__`;
          const mentionSpan = `<span class="mention${currentUser && currentUser.id===u.id? ' me':''}">@${name}</span>`;
          raw = raw.replace(new RegExp(`<@!?${u.id}>`, 'g'), marker);
          mentionHtml.push({marker, html:mentionSpan});
        });
      }
      // escape and then re-insert mention HTML
      raw = raw.replace(/</g,'&lt;').replace(/>/g,'&gt;');
      mentionHtml.forEach(mh=>{ raw = raw.replace(new RegExp(mh.marker,'g'), mh.html); });
      // render markdown (bold, italic, code, links, etc.)
      raw = renderMarkdown(raw);
      // attachments/embeds/components/stickers markers
      const markers = [];
      if(m.attachments && m.attachments.length) markers.push('[attachment]');
      if(m.embeds && m.embeds.length) markers.push('[embed]');
      if(m.stickers && m.stickers.length) markers.push('[sticker]');
      if(m.components && m.components.length){
        // heuristic: if component custom_id or type contains 'poll' mark as poll
        const hasPoll = m.components.some(c=> JSON.stringify(c).toLowerCase().includes('poll'));
        markers.push(hasPoll ? '[poll]' : '[component]');
      }
      const markersHtml = markers.length ? `<div class="markers">${markers.join(' ')}</div>` : '';
      const content = `<div class="content">${raw}</div>` + markersHtml;
      d.innerHTML = author + replyHtml + content;
      // add reply action button
      (function(){
        const metaEl = d.querySelector('.meta');
        if(metaEl){
          const rb = document.createElement('button');
          rb.textContent = 'Reply';
          rb.className = 'reply-btn';
          rb.title = 'Reply';
          rb.addEventListener('click', (ev)=>{
            ev.stopPropagation();
            // set reply target
            replyTarget = {messageId: m.id, author: displayName, snippet: (m.content||'').slice(0,120), guildId: m.guild_id};
            if(replyPreviewEl && replyMetaEl){ replyMetaEl.textContent = `Replying to ${replyTarget.author}: "${replyTarget.snippet}"`; replyPreviewEl.style.display = 'flex'; }
            // focus input
            const inp = document.getElementById('messageInput'); if(inp) inp.focus();
          });
          metaEl.appendChild(rb);
        }
      })();
      /* reactions removed */
      messagesEl.appendChild(d);
    });
    // fetch missing member display names and update DOM
    for(const [k,info] of missingMembers){
      (async ()=>{
        try{
          const mem = await api(`/api/guilds/${info.guildId}/members/${info.userId}`);
          const name = (mem.nick) || (mem.user && (mem.user.global_name || mem.user.username)) || info.userId;
          // update all message nodes for this author
          messagesEl.querySelectorAll(`[data-author-id="${info.userId}"]`).forEach(node=>{
            const meta = node.querySelector('.meta');
            if(meta){
              const parts = meta.textContent.split('•');
              const timePart = parts[1] ? parts[1].trim() : '';
              meta.textContent = '';
              const strong = document.createElement('strong');
              strong.textContent = name;
              meta.appendChild(strong);
              if(timePart) meta.appendChild(document.createTextNode(' • ' + timePart));
            }
          });
        }catch(e){/* ignore */}
      })();
    }
    // set lastMessageId to newest message id for incremental polling
    if(msgs.length) lastMessageId = msgs[0].id || msgs[msgs.length-1].id;
    // trim old messages to keep DOM small
    while(messagesEl.children.length > MAX_MESSAGES){ messagesEl.removeChild(messagesEl.firstChild); }
    scrollToBottom();
  }catch(e){
    // if access denied or not viewable, mark channel hidden and show a notice
    messagesEl.innerHTML = `<div style="color:#ffb4b4">${e.message}</div>`;
    channelHidden[channelId] = true;
    // mark UI list item if present
    const li = channelsEl.querySelector(`[data-channel-id="${channelId}"]`);
    if(li) li.classList.add('hidden');
  }
}

async function fetchNewMessages(channelId){
  if(!lastMessageId) return;
  try{
    const newMsgs = await api(`/api/channels/${channelId}/messages?limit=50&after=${lastMessageId}`);
    if(!newMsgs || !newMsgs.length) return;
    // API returns messages newest first; reverse to append oldest->newest
    const missingMembers = new Map();
    newMsgs.reverse().forEach(m=>{
      const d = document.createElement('div');
      d.className = 'msg';
      d.dataset.authorId = m.author?.id || '';
      d.dataset.messageId = m.id || '';
      d.dataset.guildId = m.guild_id || '';
      let displayName = (m.member && m.member.nick) || (m.author && (m.author.global_name || m.author.username)) || null;
      if(!displayName && m.guild_id && m.author && m.author.id){
        const key = `${m.guild_id}:${m.author.id}`;
        missingMembers.set(key, {guildId: m.guild_id, userId: m.author.id});
        displayName = m.author && (m.author.global_name || m.author.username) || 'unknown';
      }
      displayName = displayName || 'unknown';
      const author = `<div class="meta"><strong>${displayName}</strong> • ${fmtTime(m.timestamp||m.id)}</div>`;
      let replyHtml = '';
      if(m.referenced_message){
        const ref = m.referenced_message;
        const refDisplay = (ref.member && ref.member.nick) || (ref.author && (ref.author.global_name || ref.author.username)) || 'unknown';
        const refContent = (ref.content||'').replace(/</g,'&lt;');
        replyHtml = `<div class="reply"><div class="reply-author">Reply to ${refDisplay}</div><div class="reply-snippet">${refContent}</div></div>`;
      }
      let raw = (m.content||'');
      const mentionHtml = [];
      if(m.mentions && m.mentions.length){
        m.mentions.forEach((u,i)=>{
          const name = (u.username || u.global_name) || u.id;
          const marker = `__MENTION_${i}__`;
          const mentionSpan = `<span class="mention${currentUser && currentUser.id===u.id? ' me':''}">@${name}</span>`;
          raw = raw.replace(new RegExp(`<@!?${u.id}>`, 'g'), marker);
          mentionHtml.push({marker, html:mentionSpan});
        });
      }
      raw = raw.replace(/</g,'&lt;').replace(/>/g,'&gt;');
      mentionHtml.forEach(mh=>{ raw = raw.replace(new RegExp(mh.marker,'g'), mh.html); });
      // render markdown (bold, italic, code, links, etc.)
      raw = renderMarkdown(raw);
      // attachments/embeds/components/stickers markers for new messages
      const markers = [];
      if(m.attachments && m.attachments.length) markers.push('[attachment]');
      if(m.embeds && m.embeds.length) markers.push('[embed]');
      if(m.stickers && m.stickers.length) markers.push('[sticker]');
      if(m.components && m.components.length){
        const hasPoll = m.components.some(c=> JSON.stringify(c).toLowerCase().includes('poll'));
        markers.push(hasPoll ? '[poll]' : '[component]');
      }
      const markersHtml = markers.length ? `<div class="markers">${markers.join(' ')}</div>` : '';
      const content = `<div class="content">${raw}</div>` + markersHtml;
      d.innerHTML = author + replyHtml + content;
      // add reply button for new messages as well
      (function(){
        const metaEl = d.querySelector('.meta');
        if(metaEl){
          const rb = document.createElement('button');
          rb.textContent = 'Reply';
          rb.className = 'reply-btn';
          rb.title = 'Reply';
          rb.addEventListener('click', (ev)=>{
            ev.stopPropagation();
            replyTarget = {messageId: m.id, author: (m.member && m.member.nick) || (m.author && (m.author.global_name || m.author.username)) || 'unknown', snippet: (m.content||'').slice(0,120), guildId: m.guild_id};
            if(replyPreviewEl && replyMetaEl){ replyMetaEl.textContent = `Replying to ${replyTarget.author}: "${replyTarget.snippet}"`; replyPreviewEl.style.display = 'flex'; }
            const inp = document.getElementById('messageInput'); if(inp) inp.focus();
          });
          metaEl.appendChild(rb);
        }
      })();
      messagesEl.appendChild(d);
    });
    for(const [k,info] of missingMembers){
      (async ()=>{
        try{
          const mem = await api(`/api/guilds/${info.guildId}/members/${info.userId}`);
          const name = (mem.nick) || (mem.user && (mem.user.global_name || mem.user.username)) || info.userId;
          messagesEl.querySelectorAll(`[data-author-id="${info.userId}"]`).forEach(node=>{
            const meta = node.querySelector('.meta');
            if(meta) meta.innerHTML = `<strong>${name}</strong> • ${meta.textContent.split('•')[1] || ''}`;
          });
        }catch(e){/* ignore */}
      })();
    }
    // update lastMessageId to newest of returned
    lastMessageId = newMsgs[0].id || lastMessageId;
    // trim old messages to keep DOM small
    while(messagesEl.children.length > MAX_MESSAGES){ messagesEl.removeChild(messagesEl.firstChild); }
    // always keep at bottom
    scrollToBottom();
  }catch(e){
    console.warn('Polling error', e);
  }
}

function startPolling(channelId){
  stopPolling();
  pollId = setInterval(()=>fetchNewMessages(channelId), 3000);
}

function stopPolling(){
  if(pollId) clearInterval(pollId);
  pollId = null;
}

sendForm.addEventListener('submit', async (ev)=>{
  ev.preventDefault();
  if(sending) return;
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if(!content || !currentChannel) return;
  // sanitize outgoing content: replace emojis so PS4 clients don't send them
  const sanitized = replaceEmojis(content);
  const now = Date.now();
  if(content === lastSent.content && (now - lastSent.ts) < 2000){
    // debounce duplicate
    return;
  }
  sending = true;
  input.disabled = true;
  try{
    const body = {content: sanitized};
    if(replyTarget && replyTarget.messageId){ body.reply_to = replyTarget.messageId; }
    await api(`/api/channels/${currentChannel}/messages`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    lastSent = {content, ts: Date.now()};
    input.value = '';
      // after successful send, try to fetch new messages quickly
    replyTarget = null; if(replyPreviewEl) replyPreviewEl.style.display = 'none';
    await fetchNewMessages(currentChannel);
  }catch(e){
    alert('Send failed: '+e.message);
  }finally{
    sending = false;
    // ensure input is enabled
    input.disabled = false;
  }
});

loadGuilds();
