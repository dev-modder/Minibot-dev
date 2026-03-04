// pair.js - Enhanced with comprehensive commands
// Main pairing / bot management router with MongoDB
require('dotenv').config();
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const FileType = require('file-type');
const os = require('os');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const config = require('./config');

// MongoDB Connection
const connectMongoDB = async () => {
    try {
        await mongoose.connect(config.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log('✅ Connected to MongoDB successfully');
        await mongoose.connection.db.collection('sessions').createIndex({ number: 1 }, { unique: true });
        await mongoose.connection.db.collection('sessions').createIndex({ updatedAt: 1 });
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        process.exit(1);
    }
};

connectMongoDB();

// Session Schema
const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true, trim: true, match: /^\d+$/ },
    creds: { type: mongoose.Schema.Types.Mixed, required: true },
    config: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastActive: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

sessionSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const Session = mongoose.model('Session', sessionSchema);

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = config.SESSION_BASE_PATH;
const NUMBER_LIST_PATH = config.NUMBER_LIST_PATH;
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    console.log(`Session management for ${number} handled by MongoDB`);
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9-_]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message && error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message && error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message && error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        'LIGHT SPEED BOT MINI',
        `📞 Number: ${number}\n🩵 Status: Connected\n📢 Group: ${groupStatus}`,
        'LIGHT SPEED BOT'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                { image: { url: config.RCD_IMAGE_PATH }, caption }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in ${Math.floor(config.OTP_EXPIRY / 60000)} minutes.`,
        'LIGHT SPEED BOT MINI'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message || err);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message || error);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'LIGHT SPEED BOT MINI'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
};

async function oneViewmeg(socket, isOwner, msg, sender) {
    if (isOwner) {  
        try {
            const akuru = sender;
            const quot = msg;
            if (quot) {
                if (quot.imageMessage?.viewOnce) {
                    let cap = quot.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.videoMessage?.viewOnce) {
                    let cap = quot.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.audioMessage?.viewOnce) {
                    let cap = quot.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.imageMessage){
                    let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
                    await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2?.message?.videoMessage){
                    let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
                    await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
                } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
                    let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
                    let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
                    await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
                }
            }        
        } catch (error) {
            console.error('oneViewmeg error:', error);
        }
    }
}

function setupCommandHandlers(socket, number) {
    const verifiedContact = {
        key: {
            fromMe: false,
            participant: `0@s.whatsapp.net`,
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "Moon Xmd✅",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN: Keith ✅\nORG:Moon Xmd;\nTEL;type=CELL;type=VOICE;waid=263776509966:+263786831091\nEND:VCARD"
            }
        }
    };

    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted = type == "extendedTextMessage" && msg.message.extendedTextMessage.contextInfo != null
            ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
            : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
            ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
            ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
            ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
            ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
            ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
            ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
            ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
            ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                || msg.text) 
            : (type === 'viewOnceMessage') 
            ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
            ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = (body || '').startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = (body || '').trim().split(/ +/).slice(1);

        socket.downloadAndSaveMediaMessage = async(message, filename = (Date.now()).toString(), attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + (type ? type.ext : 'bin')) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        }

        if (!command) return;

        try {
            switch (command) {
                 case 'menu': {
                   const startTime = socketCreationTime.get(number) || Date.now();
                   const uptime = Math.floor((Date.now() - startTime) / 1000);
                   const hours = Math.floor(uptime / 3600);
                   const minutes = Math.floor((uptime % 3600) / 60);
                   const seconds = Math.floor(uptime % 60);
   
                   let menuText = `
   ╭───❖ *MOON X MINI* ❖───╮
   ├❖ *Bot Name:* *LIGHT SPEED MINI BOT*
   ├❖ *Owner :* LIGHT-DEV
   ├❖ *Status:* *Online*
   ├❖ *Runtime:* ${hours}h ${minutes}m ${seconds}s
   ├❖ *Platform :* Heroku
   ├❖ *Mode :* Public
   ├❖ *Active Users:* ${activeSockets.size}
   ├❖ *Developer:* LIGHT-DEV
   ╰───────────────────────
   
   ╭───❖ *MAIN MENU* ❖───╮
   ├❖ ${config.PREFIX}alive
   ├❖ ${config.PREFIX}menu
   ├❖ ${config.PREFIX}ping
   ├❖ ${config.PREFIX}ai
   ╰───────────────────────
   
   ╭───❖ *GROUP MENU* ❖───╮
   ├❖ ${config.PREFIX}grouplist
   ├❖ ${config.PREFIX}groupinfo
   ├❖ ${config.PREFIX}invite
   ├❖ ${config.PREFIX}kick
   ├❖ ${config.PREFIX}add
   ├❖ ${config.PREFIX}promote
   ├❖ ${config.PREFIX}demote
   ├❖ ${config.PREFIX}tagall
   ├❖ ${config.PREFIX}hidetag
   ├❖ ${config.PREFIX}setname
   ├❖ ${config.PREFIX}setdesc
   ├❖ ${config.PREFIX}setpp
   ├❖ ${config.PREFIX}mute
   ├❖ ${config.PREFIX}unmute
   ├❖ ${config.PREFIX}lock
   ├❖ ${config.PREFIX}unlock
   ├❖ ${config.PREFIX}link
   ├❖ ${config.PREFIX}stopjadibot
   ├❖ ${config.PREFIX}stoprent
   ├❖ ${config.PREFIX}listjadibot
   ├❖ ${config.PREFIX}listrent
   ╰───────────────────────
   
   ╭───❖ *PRIVATE MENU* ❖───╮
   ├❖ ${config.PREFIX}block
   ├❖ ${config.PREFIX}unblock
   ├❖ ${config.PREFIX}getbio
   ├❖ ${config.PREFIX}getpp
   ├❖ ${config.PREFIX}save
   ├❖ ${config.PREFIX}forward
   ╰───────────────────────
   
   ╭───❖ *TOOLS MENU* ❖───╮
   ├❖ ${config.PREFIX}weather
   ├❖ ${config.PREFIX}translate
   ├❖ ${config.PREFIX}calc
   ├❖ ${config.PREFIX}qr
   ├❖ ${config.PREFIX}shorten
   ├❖ ${config.PREFIX}currency
   ├❖ ${config.PREFIX}define
   ├❖ ${config.PREFIX}joke
   ├❖ ${config.PREFIX}quote
   ├❖ ${config.PREFIX}fact
   ├❖ ${config.PREFIX}advice
   ├❖ ${config.PREFIX}fetch
   ├❖ ${config.PREFIX}get
   ├❖ ${config.PREFIX}toaud
   ├❖ ${config.PREFIX}toaudio
   ├❖ ${config.PREFIX}tomp3
   ├❖ ${config.PREFIX}tovn
   ├❖ ${config.PREFIX}toptt
   ├❖ ${config.PREFIX}tovoice
   ├❖ ${config.PREFIX}togif
   ├❖ ${config.PREFIX}toimage
   ├❖ ${config.PREFIX}toimg
   ├❖ ${config.PREFIX}toptv
   ├❖ ${config.PREFIX}tourl
   ├❖ ${config.PREFIX}texttospech
   ├❖ ${config.PREFIX}tts
   ├❖ ${config.PREFIX}tospech
   ├❖ ${config.PREFIX}translate
   ├❖ ${config.PREFIX}tr
   ├❖ ${config.PREFIX}toqr
   ├❖ ${config.PREFIX}qr
   ├❖ ${config.PREFIX}tohd
   ├❖ ${config.PREFIX}remini
   ├❖ ${config.PREFIX}hd
   ├❖ ${config.PREFIX}dehaze
   ├❖ ${config.PREFIX}colorize
   ├❖ ${config.PREFIX}colorfull
   ├❖ ${config.PREFIX}hitamkan
   ├❖ ${config.PREFIX}toblack
   ├❖ ${config.PREFIX}ssweb
   ├❖ ${config.PREFIX}readmore
   ├❖ ${config.PREFIX}getexif
   ├❖ ${config.PREFIX}cuaca
   ├❖ ${config.PREFIX}tinyurl
   ├❖ ${config.PREFIX}shorturl
   ├❖ ${config.PREFIX}shortlink
   ├❖ ${config.PREFIX}git
   ├❖ ${config.PREFIX}gitclone
   ├❖ ${config.PREFIX}define
   ├❖ ${config.PREFIX}dictionary
   ╰───────────────────────
   
   ╭───❖ *STICKER MENU* ❖───╮
   ├❖ ${config.PREFIX}sticker
   ├❖ ${config.PREFIX}stiker
   ├❖ ${config.PREFIX}s
   ├❖ ${config.PREFIX}stickergif
   ├❖ ${config.PREFIX}stikergif
   ├❖ ${config.PREFIX}sgif
   ├❖ ${config.PREFIX}stickerwm
   ├❖ ${config.PREFIX}swm
   ├❖ ${config.PREFIX}curi
   ├❖ ${config.PREFIX}colong
   ├❖ ${config.PREFIX}take
   ├❖ ${config.PREFIX}stickergifwm
   ├❖ ${config.PREFIX}sgifwm
   ├❖ ${config.PREFIX}smeme
   ├❖ ${config.PREFIX}stickmeme
   ├❖ ${config.PREFIX}emojimix
   ├❖ ${config.PREFIX}qc
   ├❖ ${config.PREFIX}quote
   ├❖ ${config.PREFIX}fakechat
   ├❖ ${config.PREFIX}brat
   ├❖ ${config.PREFIX}bratvid
   ├❖ ${config.PREFIX}bratvideo
   ├❖ ${config.PREFIX}wasted
   ├❖ ${config.PREFIX}trigger
   ├❖ ${config.PREFIX}triggered
   ╰───────────────────────
   
   ╭───❖ *AUDIO EFFECTS* ❖───╮
   ├❖ ${config.PREFIX}bass
   ├❖ ${config.PREFIX}blown
   ├❖ ${config.PREFIX}deep
   ├❖ ${config.PREFIX}earrape
   ├❖ ${config.PREFIX}fast
   ├❖ ${config.PREFIX}fat
   ├❖ ${config.PREFIX}nightcore
   ├❖ ${config.PREFIX}reverse
   ├❖ ${config.PREFIX}robot
   ├❖ ${config.PREFIX}slow
   ├❖ ${config.PREFIX}smooth
   ├❖ ${config.PREFIX}tupai
   ╰───────────────────────
   
   ╭───❖ *AI MENU* ❖───╮
   ├❖ ${config.PREFIX}ai
   ├❖ ${config.PREFIX}simi
   ├❖ ${config.PREFIX}bard
   ├❖ ${config.PREFIX}gemini
   ├❖ ${config.PREFIX}aiedit
   ╰───────────────────────
   
   ╭───❖ *SEARCH MENU* ❖───╮
   ├❖ ${config.PREFIX}google
   ├❖ ${config.PREFIX}bing
   ├❖ ${config.PREFIX}wiki
   ├❖ ${config.PREFIX}wikipedia
   ├❖ ${config.PREFIX}technews
   ├❖ ${config.PREFIX}wattpad
   ├❖ ${config.PREFIX}gimage
   ├❖ ${config.PREFIX}bingimg
   ├❖ ${config.PREFIX}trendtwit
   ├❖ ${config.PREFIX}trends
   ├❖ ${config.PREFIX}xtrends
   ├❖ ${config.PREFIX}play
   ├❖ ${config.PREFIX}ytplay
   ├❖ ${config.PREFIX}yts
   ├❖ ${config.PREFIX}ytsearch
   ├❖ ${config.PREFIX}youtubesearch
   ├❖ ${config.PREFIX}pixiv
   ├❖ ${config.PREFIX}pinterest
   ├❖ ${config.PREFIX}pint
   ├❖ ${config.PREFIX}wallpaper
   ├❖ ${config.PREFIX}ringtone
   ├❖ ${config.PREFIX}npm
   ├❖ ${config.PREFIX}npmjs
   ├❖ ${config.PREFIX}style
   ├❖ ${config.PREFIX}spotify
   ├❖ ${config.PREFIX}spotifysearch
   ├❖ ${config.PREFIX}tenor
   ├❖ ${config.PREFIX}urban
   ╰───────────────────────
   
   ╭───❖ *DOWNLOADER MENU* ❖───╮
   ├❖ ${config.PREFIX}img
   ├❖ ${config.PREFIX}wallpaper
   ├❖ ${config.PREFIX}gdrive
   ├❖ ${config.PREFIX}mediafire
   ├❖ ${config.PREFIX}apk
   ╰───────────────────────
   
   ╭───❖ *MEDIA MENU* ❖───╮
   ├❖ ${config.PREFIX}song
   ├❖ ${config.PREFIX}tiktok
   ├❖ ${config.PREFIX}fb
   ├❖ ${config.PREFIX}ig
   ├❖ ${config.PREFIX}ts
   ├❖ ${config.PREFIX}aiimg
   ╰───────────────────────
   
   ╭───❖ *NEWS MENU* ❖───╮
   ├❖ ${config.PREFIX}news
   ├❖ ${config.PREFIX}nasa
   ├❖ ${config.PREFIX}cricket
   ├❖ ${config.PREFIX}gossip
   ╰───────────────────────
   
   ╭───❖ *MODERATION MENU* ❖───╮
   ├❖ ${config.PREFIX}antilink
   ├❖ ${config.PREFIX}antispam
   ├❖ ${config.PREFIX}welcome
   ├❖ ${config.PREFIX}goodbye
   ╰───────────────────────
   
   ╭───❖ *OWNER MENU* ❖───╮
   ├❖ ${config.PREFIX}broadcast
   ├❖ ${config.PREFIX}clearchat
   ├❖ ${config.PREFIX}leave
   ├❖ ${config.PREFIX}join
   ╰───────────────────────
   
   ╭───❖ *STALKER MENU* ❖───╮
   ├❖ ${config.PREFIX}igstalk
   ├❖ ${config.PREFIX}instagramstalk
   ├❖ ${config.PREFIX}wastalk
   ├❖ ${config.PREFIX}whatsappstalk
   ├❖ ${config.PREFIX}telestalk
   ├❖ ${config.PREFIX}telegramstalk
   ├❖ ${config.PREFIX}tiktokstalk
   ├❖ ${config.PREFIX}ttstalk
   ├❖ ${config.PREFIX}genshinstalk
   ├❖ ${config.PREFIX}gistalk
   ├❖ ${config.PREFIX}ghstalk
   ├❖ ${config.PREFIX}githubstalk
   ├❖ ${config.PREFIX}npmstalk
   ╰───────────────────────
   
   ╭───❖ *ANIME MENU* ❖───╮
   ├❖ ${config.PREFIX}anime
   ├❖ ${config.PREFIX}manga
   ├❖ ${config.PREFIX}character
   ├❖ ${config.PREFIX}waifu
   ├❖ ${config.PREFIX}neko
   ├❖ ${config.PREFIX}husbando
   ╰───────────────────────
   
   ╭───❖ *FUN MENU* ❖───╮
   ├❖ ${config.PREFIX}truth
   ├❖ ${config.PREFIX}dare
   ├❖ ${config.PREFIX}roll
   ├❖ ${config.PREFIX}flip
   ├❖ ${config.PREFIX}rps
   ├❖ ${config.PREFIX}8ball
   ├❖ ${config.PREFIX}rate
   ├❖ ${config.PREFIX}ship
   ╰───────────────────────
   
   ╭───❖ *UTILITY MENU* ❖───╮
   ├❖ ${config.PREFIX}time
   ├❖ ${config.PREFIX}date
   ├❖ ${config.PREFIX}reminder
   ├❖ ${config.PREFIX}note
   ├❖ ${config.PREFIX}ttp
   ├❖ ${config.PREFIX}attp
   ╰───────────────────────
   
   ╭───❖ *CHAT MENU* ❖───╮
   ├❖ ${config.PREFIX}poll
   ├❖ ${config.PREFIX}list
   ├❖ ${config.PREFIX}button
   ├❖ ${config.PREFIX}react
   ├❖ ${config.PREFIX}delete
   ├❖ ${config.PREFIX}edit
   ├❖ ${config.PREFIX}forwardall
   ├❖ ${config.PREFIX}spam
   ├❖ ${config.PREFIX}blocklist
   ├❖ ${config.PREFIX}getid
   ├❖ ${config.PREFIX}getjid
   ├❖ ${config.PREFIX}read
   ├❖ ${config.PREFIX}archive
   ├❖ ${config.PREFIX}unarchive
   ├❖ ${config.PREFIX}pin
   ├❖ ${config.PREFIX}unpin
   ├❖ ${config.PREFIX}mutechat
   ├❖ ${config.PREFIX}unmutechat
   ╰───────────────────────
   
   ╭───❖ *PROFILE MENU* ❖───╮
   ├❖ ${config.PREFIX}profile
   ├❖ ${config.PREFIX}setstatus
   ├❖ ${config.PREFIX}setnamebot
   ├❖ ${config.PREFIX}setppbot
   ╰───────────────────────
   
   ╭───❖ *INFO MENU* ❖───╮
   ├❖ ${config.PREFIX}help
   ├❖ ${config.PREFIX}stats
   ├❖ ${config.PREFIX}settings
   ╰───────────────────────`;
   
                   await socket.sendMessage(from, {
                       image: { url: config.RCD_IMAGE_PATH },
                       caption: formatMessage('*LIGHT SPEED MINI BOT*', menuText, 'LIGHT SPEED'),
                       contextInfo: {
                           mentionedJid: [msg.key.participant || sender],
                           forwardingScore: 999,
                           isForwarded: true,
                           forwardedNewsletterMessageInfo: {
                               newsletterJid: (config.NEWSLETTER_JID || '').trim(),
                               newsletterName: 'M O O N  𝚡 𝚠 𝚡',
                               serverMessageId: 143
                           }
                       }
                   }, { quoted: verifiedContact });
                   break;
                 }

              case 'alive': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const captionText = `
╭────◉◉◉────៚
⏰ Bot Uptime: ${hours}h ${minutes}m ${seconds}s
🟢 Active Bots: ${activeSockets.size}
╰────◉◉◉────៚

🔢 Your Number: ${number}
`;

                await socket.sendMessage(m.chat, {
                    buttons: [
                        {
                            buttonId: 'action',
                            buttonText: { displayText: '📂 Menu Options' },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Click Here',
                                    sections: [
                                        {
                                            title: `LIGHT SPEED`,
                                            highlight_label: '',
                                            rows: [
                                                { title: 'menu', description: 'LIGHT SPEED', id: `${config.PREFIX}menu` },
                                                { title: 'Alive', description: 'LIGHT SPEED', id: `${config.PREFIX}alive` },
                                            ],
                                        },
                                    ],
                                }),
                            },
                        },
                    ],
                    headerType: 1,
                    viewOnce: true,
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: `MOON XMD\n\n${captionText}`,
                }, { quoted: msg });
                break;
              }

              case 'ping': {
                try {
                    const start = Date.now();
                    const sentMsg = await socket.sendMessage(sender, { text: '```Pinging...```' }, { quoted: msg });
                    const responseTime = Date.now() - start;
                    const formattedTime = responseTime.toFixed(3);
                    const pinginfo = `🔸️ *Response:* ${formattedTime} ms`.trim();
                    await socket.sendMessage(sender, { text: pinginfo, edit: sentMsg.key });
                } catch (error) {
                    console.error('❌ Error in ping command:', error);
                    await socket.sendMessage(sender, { text: '❌ Failed to get response speed.' }, { quoted: msg });
                }
                break;
              }

              case 'ai': {
                const axios = require("axios");
                const apiKeyUrl = 'https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/aiapikey.json';

                let GEMINI_API_KEY;
                try {
                  const configRes = await axios.get(apiKeyUrl);
                  GEMINI_API_KEY = configRes.data?.GEMINI_API_KEY;
                  if (!GEMINI_API_KEY) {
                    throw new Error("API key not found in JSON.");
                  }
                } catch (err) {
                  console.error("❌ Error loading API key:", err.message || err);
                  return await socket.sendMessage(sender, { text: "❌ AI service unavailable" }, { quoted: msg });
                }

                const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

                const q = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';

                if (!q || q.trim() === '') {
                  return await socket.sendMessage(sender, { text: "M O O N  𝗫 𝗠 𝗗 *AI*\n\n*Usage:* .ai <your question>" }, { quoted: msg });
                }

                const prompt = `You are Moon Ai an Ai developed By Keith Tech , When asked about your creator say Keith Tech and when u reply to anyone put a footer below ur messages > powered by keith tech, You are from Zimbabwe, You speak English and Shona: ${q}`;

                const payload = { contents: [{ parts: [{ text: prompt }] }] };

                try {
                  const response = await axios.post(GEMINI_API_URL, payload, { headers: { "Content-Type": "application/json" } });
                  const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

                  if (!aiResponse) {
                    return await socket.sendMessage(sender, { text: "❌ No response from AI" }, { quoted: msg });
                  }

                  await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

                } catch (err) {
                  console.error("Gemini API Error:", err.response?.data || err.message || err);
                  await socket.sendMessage(sender, { text: "❌ AI error occurred" }, { quoted: msg });
                }

                break;
              }

              case 'deleteme': {
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                }
                await deleteSessionFromStorage(number);
                if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                    try {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                    } catch {}
                    activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                }
                await socket.sendMessage(sender, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage('🗑️ SESSION DELETED', '✅ Your session has been successfully deleted.', 'M O O N  𝗫 𝗠 𝗗')
                });
                break;
              }

              // ==================== GROUP COMMANDS ====================
              case 'grouplist': {
                try {
                    const groups = await socket.groupFetchAllParticipating();
                    const groupList = Object.values(groups).map(g => 
                        `📛 *${g.subject}*\n👥 Members: ${g.participants.length}\n🆔 ID: ${g.id}`
                    ).join('\n\n');
                    
                    await socket.sendMessage(sender, {
                        text: `📋 *GROUP LIST*\n\n${groupList}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch group list' }, { quoted: msg });
                }
                break;
              }

              case 'groupinfo': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id).join(', ');
                    const owner = groupMetadata.owner || 'Unknown';
                    
                    const infoText = `
📛 *Group Name:* ${groupMetadata.subject}
🆔 *Group ID:* ${groupMetadata.id}
👥 *Members:* ${groupMetadata.participants.length}
👑 *Owner:* ${owner.split('@')[0]}
🛡️ *Admins:* ${admins || 'None'}
📝 *Description:* ${groupMetadata.desc || 'No description'}
🕒 *Created:* ${groupMetadata.creation ? new Date(groupMetadata.creation * 1000).toLocaleString() : 'Unknown'}
                    `.trim();
                    
                    await socket.sendMessage(sender, {
                        text: infoText,
                        contextInfo: { mentionedJid: groupMetadata.participants.map(p => p.id) }
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch group info' }, { quoted: msg });
                }
                break;
              }

              case 'invite': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                try {
                    const code = await socket.groupInviteCode(from);
                    const link = `https://chat.whatsapp.com/${code}`;
                    
                    await socket.sendMessage(sender, {
                        text: `🔗 *Group Invite Link*\n\n${link}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate invite link' }, { quoted: msg });
                }
                break;
              }

              case 'kick': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!msg.quoted && !args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message or mention a user to kick' }, { quoted: msg });
                }
                
                try {
                    const users = msg.quoted ? [msg.quoted.sender] : msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    
                    for (const user of users) {
                        await socket.groupParticipantsUpdate(from, [user], 'remove');
                    }
                    
                    await socket.sendMessage(sender, { text: `✅ Kicked ${users.length} user(s)` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to kick user(s)' }, { quoted: msg });
                }
                break;
              }

              case 'add': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a phone number to add' }, { quoted: msg });
                }
                
                try {
                    const number = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    await socket.groupParticipantsUpdate(from, [number], 'add');
                    await socket.sendMessage(sender, { text: '✅ Adding user to group...' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to add user. Make sure the number is correct and has WhatsApp.' }, { quoted: msg });
                }
                break;
              }

              case 'promote': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!msg.quoted && !args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message or mention a user to promote' }, { quoted: msg });
                }
                
                try {
                    const users = msg.quoted ? [msg.quoted.sender] : msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    
                    for (const user of users) {
                        await socket.groupParticipantsUpdate(from, [user], 'promote');
                    }
                    
                    await socket.sendMessage(sender, { text: `✅ Promoted ${users.length} user(s) to admin` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to promote user(s)' }, { quoted: msg });
                }
                break;
              }

              case 'demote': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!msg.quoted && !args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message or mention a user to demote' }, { quoted: msg });
                }
                
                try {
                    const users = msg.quoted ? [msg.quoted.sender] : msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    
                    for (const user of users) {
                        await socket.groupParticipantsUpdate(from, [user], 'demote');
                    }
                    
                    await socket.sendMessage(sender, { text: `✅ Demoted ${users.length} admin(s)` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to demote user(s)' }, { quoted: msg });
                }
                break;
              }

              case 'tagall': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const mentions = groupMetadata.participants.map(p => p.id);
                    const message = args.join(' ') || '📢 *Attention Everyone!*';
                    
                    await socket.sendMessage(from, {
                        text: `${message}\n\n${mentions.map(jid => `@${jid.split('@')[0]}`).join(' ')}`,
                        mentions: mentions
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to tag all members' }, { quoted: msg });
                }
                break;
              }

              case 'hidetag': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const mentions = groupMetadata.participants.map(p => p.id);
                    const message = args.join(' ') || '📢 *Hidden Tag Message*';
                    
                    await socket.sendMessage(from, {
                        text: message,
                        mentions: mentions
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to send hidden tag' }, { quoted: msg });
                }
                break;
              }

              case 'setname': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a new group name' }, { quoted: msg });
                }
                
                try {
                    await socket.groupUpdateSubject(from, args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Group name updated successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update group name' }, { quoted: msg });
                }
                break;
              }

              case 'setdesc': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a new group description' }, { quoted: msg });
                }
                
                try {
                    await socket.groupUpdateDescription(from, args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Group description updated successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update group description' }, { quoted: msg });
                }
                break;
              }

              case 'setpp': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                if (!msg.message?.imageMessage) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image to set as profile picture' }, { quoted: msg });
                }
                
                try {
                    const media = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of media) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    
                    await socket.updateProfilePicture(isGroup ? from : jidNormalizedUser(socket.user.id), buffer);
                    await socket.sendMessage(sender, { text: '✅ Profile picture updated successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update profile picture' }, { quoted: msg });
                }
                break;
              }

              case 'mute': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    const duration = args[0] ? parseInt(args[0]) : 1;
                    await socket.groupSettingUpdate(from, 'announcement');
                    await socket.sendMessage(sender, { text: `✅ Group muted for ${duration} hour(s)` }, { quoted: msg });
                    
                    if (duration > 0) {
                        setTimeout(async () => {
                            try {
                                await socket.groupSettingUpdate(from, 'not_announcement');
                            } catch {}
                        }, duration * 60 * 60 * 1000);
                    }
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to mute group' }, { quoted: msg });
                }
                break;
              }

              case 'unmute': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    await socket.groupSettingUpdate(from, 'not_announcement');
                    await socket.sendMessage(sender, { text: '✅ Group unmuted successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unmute group' }, { quoted: msg });
                }
                break;
              }

              case 'lock': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    await socket.groupSettingUpdate(from, 'locked');
                    await socket.sendMessage(sender, { text: '✅ Group locked - only admins can edit group info' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to lock group' }, { quoted: msg });
                }
                break;
              }

              case 'unlock': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    await socket.groupSettingUpdate(from, 'unlocked');
                    await socket.sendMessage(sender, { text: '✅ Group unlocked - all members can edit group info' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unlock group' }, { quoted: msg });
                }
                break;
              }

              case 'link': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                try {
                    const code = await socket.groupInviteCode(from);
                    await socket.sendMessage(sender, {
                        text: `🔗 *Group Link*\n\nhttps://chat.whatsapp.com/${code}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to get group link' }, { quoted: msg });
                }
                break;
              }

              // ==================== PRIVATE CHAT COMMANDS ====================
              case 'block': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                const target = msg.quoted ? msg.quoted.sender : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                
                try {
                    await socket.updateBlockStatus(target, 'block');
                    await socket.sendMessage(sender, { text: '✅ User blocked successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to block user' }, { quoted: msg });
                }
                break;
              }

              case 'unblock': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                const target = msg.quoted ? msg.quoted.sender : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                
                try {
                    await socket.updateBlockStatus(target, 'unblock');
                    await socket.sendMessage(sender, { text: '✅ User unblocked successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unblock user' }, { quoted: msg });
                }
                break;
              }

              case 'getbio': {
                const target = msg.quoted ? msg.quoted.sender : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                
                try {
                    const status = await socket.fetchStatus(target);
                    await socket.sendMessage(sender, {
                        text: `📝 *Bio Status*\n\n${status.status}\n\n🕒 Updated: ${new Date(status.setAt).toLocaleString()}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch bio' }, { quoted: msg });
                }
                break;
              }

              case 'getpp': {
                const target = msg.quoted ? msg.quoted.sender : (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender);
                
                try {
                    const ppUrl = await socket.profilePictureUrl(target, 'image');
                    await socket.sendMessage(sender, {
                        image: { url: ppUrl },
                        caption: `👤 *Profile Picture*\n\n${target.split('@')[0]}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ No profile picture found' }, { quoted: msg });
                }
                break;
              }

              case 'save': {
                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message to save it' }, { quoted: msg });
                }
                
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), msg.quoted, { forward: { scoring: true } });
                    await socket.sendMessage(sender, { text: '✅ Message saved to your chat' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to save message' }, { quoted: msg });
                }
                break;
              }

              case 'forward': {
                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message to forward' }, { quoted: msg });
                }
                
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a number or group ID to forward to' }, { quoted: msg });
                }
                
                try {
                    const target = args[0].includes('@g.us') ? args[0] : args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    await socket.sendMessage(target, msg.quoted, { forward: { scoring: true } });
                    await socket.sendMessage(sender, { text: '✅ Message forwarded successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to forward message' }, { quoted: msg });
                }
                break;
              }

              // ==================== TOOLS COMMANDS ====================
              case 'weather': {
                const city = args.join(' ');
                
                if (!city) {
                    return await socket.sendMessage(sender, { text: '❌ Please provide a city name\n\nExample: .weather London' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=metric&appid=4d8fb5b93d4af21d66a2948710284366`);
                    const data = response.data;
                    
                    const weatherText = `
🌤️ *Weather in ${data.name}, ${data.sys.country}*

🌡️ *Temperature:* ${data.main.temp}°C
🤒 *Feels Like:* ${data.main.feels_like}°C
📊 *Humidity:* ${data.main.humidity}%
💨 *Wind Speed:* ${data.wind.speed} m/s
☁️ *Description:* ${data.weather[0].description}
🌅 *Sunrise:* ${new Date(data.sys.sunrise * 1000).toLocaleTimeString()}
🌇 *Sunset:* ${new Date(data.sys.sunset * 1000).toLocaleTimeString()}

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, { text: weatherText }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ City not found or API error' }, { quoted: msg });
                }
                break;
              }

              case 'translate': {
                if (args.length < 2) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .translate <language_code> <text>\n\nExample: .translate es Hello World' }, { quoted: msg });
                }
                
                const targetLang = args[0];
                const text = args.slice(1).join(' ');
                
                try {
                    const response = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`);
                    const translatedText = response.data.responseData.translatedText;
                    
                    await socket.sendMessage(sender, {
                        text: `🌐 *Translation*\n\n*Original:* ${text}\n\n*Translated (${targetLang}):* ${translatedText}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Translation failed' }, { quoted: msg });
                }
                break;
              }

              case 'calc': {
                const expression = args.join(' ');
                
                if (!expression) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .calc <expression>\n\nExample: .calc 2+2*3' }, { quoted: msg });
                }
                
                try {
                    const result = eval(expression.replace(/[^0-9+\-*/().%]/g, ''));
                    await socket.sendMessage(sender, {
                        text: `🧮 *Calculator*\n\n*Expression:* ${expression}\n*Result:* ${result}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Invalid expression' }, { quoted: msg });
                }
                break;
              }

              case 'qr': {
                const text = args.join(' ');
                
                if (!text) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .qr <text>\n\nExample: .qr https://example.com' }, { quoted: msg });
                }
                
                try {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
                    await socket.sendMessage(sender, {
                        image: { url: qrUrl },
                        caption: `📱 *QR Code*\n\n${text}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate QR code' }, { quoted: msg });
                }
                break;
              }

              case 'shorten': {
                const url = args[0];
                
                if (!url) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .shorten <url>\n\nExample: .shorten https://example.com' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
                    await socket.sendMessage(sender, {
                        text: `🔗 *Shortened URL*\n\n*Original:* ${url}\n*Short:* ${response.data}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to shorten URL' }, { quoted: msg });
                }
                break;
              }

              case 'currency': {
                if (args.length < 3) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .currency <amount> <from> <to>\n\nExample: .currency 100 USD EUR' }, { quoted: msg });
                }
                
                const amount = parseFloat(args[0]);
                const from = args[1].toUpperCase();
                const to = args[2].toUpperCase();
                
                try {
                    const response = await axios.get(`https://api.exchangerate-api.com/v4/latest/${from}`);
                    const rate = response.data.rates[to];
                    const result = (amount * rate).toFixed(2);
                    
                    await socket.sendMessage(sender, {
                        text: `💱 *Currency Converter*\n\n${amount} ${from} = ${result} ${to}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Currency conversion failed' }, { quoted: msg });
                }
                break;
              }

              case 'define': {
                const word = args.join(' ');
                
                if (!word) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .define <word>\n\nExample: .define hello' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
                    const entry = response.data[0];
                    const meaning = entry.meanings[0];
                    
                    await socket.sendMessage(sender, {
                        text: `📖 *Dictionary*\n\n*Word:* ${entry.word}\n*Phonetic:* ${entry.phonetic || 'N/A'}\n*Part of Speech:* ${meaning.partOfSpeech}\n*Definition:* ${meaning.definitions[0].definition}\n*Example:* ${meaning.definitions[0].example || 'N/A'}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Word not found' }, { quoted: msg });
                }
                break;
              }

              case 'joke': {
                try {
                    const response = await axios.get('https://official-joke-api.appspot.com/random_joke');
                    const joke = response.data;
                    
                    await socket.sendMessage(sender, {
                        text: `😂 *Joke*\n\n${joke.setup}\n\n${joke.punchline}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch joke' }, { quoted: msg });
                }
                break;
              }

              case 'quote': {
                try {
                    const response = await axios.get('https://api.quotable.io/random');
                    const quote = response.data;
                    
                    await socket.sendMessage(sender, {
                        text: `💭 *Quote*\n\n"${quote.content}"\n\n— ${quote.author}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch quote' }, { quoted: msg });
                }
                break;
              }

              case 'fact': {
                try {
                    const response = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
                    const fact = response.data;
                    
                    await socket.sendMessage(sender, {
                        text: `🧠 *Random Fact*\n\n${fact.text}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch fact' }, { quoted: msg });
                }
                break;
              }

              case 'advice': {
                try {
                    const response = await axios.get('https://api.adviceslip.com/advice');
                    const advice = response.data.slip;
                    
                    await socket.sendMessage(sender, {
                        text: `💡 *Advice*\n\n${advice.advice}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch advice' }, { quoted: msg });
                }
                break;
              }

              // ==================== ANIME COMMANDS ====================
              case 'anime': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .anime <anime_name>\n\nExample: .anime Naruto' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=1`);
                    const anime = response.data.data[0];
                    
                    const animeText = `
🎬 *Anime Information*

📺 *Title:* ${anime.title}
📝 *Japanese:* ${anime.title_japanese}
⭐ *Score:* ${anime.score}/10
📊 *Rank:* #${anime.rank}
👥 *Members:* ${anime.members.toLocaleString()}
🔞 *Rating:* ${anime.rating}
📅 *Aired:* ${anime.aired.string}
📺 *Episodes:* ${anime.episodes || 'Ongoing'}
⏱️ *Duration:* ${anime.duration}
🎭 *Genres:* ${anime.genres.map(g => g.name).join(', ')}
📖 *Synopsis:* ${anime.synopsis?.substring(0, 300)}...

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, {
                        image: { url: anime.images.jpg.large_image_url },
                        caption: animeText
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Anime not found' }, { quoted: msg });
                }
                break;
              }

              case 'manga': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .manga <manga_name>\n\nExample: .manga One Piece' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.jikan.moe/v4/manga?q=${encodeURIComponent(query)}&limit=1`);
                    const manga = response.data.data[0];
                    
                    const mangaText = `
📚 *Manga Information*

📖 *Title:* ${manga.title}
📝 *Japanese:* ${manga.title_japanese}
⭐ *Score:* ${manga.score}/10
📊 *Rank:* #${manga.rank}
👥 *Members:* ${manga.members.toLocaleString()}
📅 *Published:* ${manga.published.string}
📄 *Chapters:* ${manga.chapters || 'Ongoing'}
📚 *Volumes:* ${manga.volumes || 'Ongoing'}
🎭 *Genres:* ${manga.genres.map(g => g.name).join(', ')}
📖 *Synopsis:* ${manga.synopsis?.substring(0, 300)}...

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, {
                        image: { url: manga.images.jpg.large_image_url },
                        caption: mangaText
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Manga not found' }, { quoted: msg });
                }
                break;
              }

              case 'character': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .character <character_name>\n\nExample: .character Naruto Uzumaki' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.jikan.moe/v4/characters?q=${encodeURIComponent(query)}&limit=1`);
                    const character = response.data.data[0];
                    
                    const charText = `
👤 *Character Information*

🎭 *Name:* ${character.name}
📝 *Japanese:* ${character.name_kanji}
🔗 *About:* ${character.about?.substring(0, 300) || 'No information available'}...

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, {
                        image: { url: character.images.jpg.large_image_url },
                        caption: charText
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Character not found' }, { quoted: msg });
                }
                break;
              }

              case 'waifu': {
                try {
                    const response = await axios.get('https://api.waifu.im/search');
                    const waifu = response.data.images[0];
                    
                    await socket.sendMessage(sender, {
                        image: { url: waifu.url },
                        caption: `🎀 *Waifu*\n\nArtist: ${waifu.artist || 'Unknown'}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch waifu' }, { quoted: msg });
                }
                break;
              }

              case 'neko': {
                try {
                    const response = await axios.get('https://api.waifu.im/search?included_tags=neko');
                    const neko = response.data.images[0];
                    
                    await socket.sendMessage(sender, {
                        image: { url: neko.url },
                        caption: `🐱 *Neko*\n\nArtist: ${neko.artist || 'Unknown'}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch neko' }, { quoted: msg });
                }
                break;
              }

              case 'husbando': {
                try {
                    const response = await axios.get('https://api.waifu.im/search?included_tags=husbando');
                    const husbando = response.data.images[0];
                    
                    await socket.sendMessage(sender, {
                        image: { url: husbando.url },
                        caption: `🤵 *Husbando*\n\nArtist: ${husbando.artist || 'Unknown'}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch husbando' }, { quoted: msg });
                }
                break;
              }

              // ==================== FUN COMMANDS ====================
              case 'truth': {
                const truths = [
                    "What's your biggest fear?",
                    "What's your most embarrassing moment?",
                    "Have you ever lied to your best friend?",
                    "What's your secret talent?",
                    "What's the worst gift you've ever received?",
                    "Have you ever cheated on a test?",
                    "What's your guilty pleasure?",
                    "What's the most childish thing you still do?",
                    "Have you ever pretended to like a gift you actually hated?",
                    "What's the biggest lie you've ever told?",
                    "What's your most irrational fear?",
                    "Have you ever had a crush on a friend's partner?",
                    "What's the most embarrassing thing in your phone?",
                    "What's the worst date you've been on?",
                    "Have you ever blamed someone else for something you did?"
                ];
                
                const randomTruth = truths[Math.floor(Math.random() * truths.length)];
                
                await socket.sendMessage(sender, {
                    text: `🎯 *Truth*\n\n${randomTruth}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'dare': {
                const dares = [
                    "Do 10 push-ups right now",
                    "Send a screenshot of your last conversation",
                    "Call someone and sing 'Happy Birthday'",
                    "Post an embarrassing photo on social media",
                    "Do your best impression of someone in the group",
                    "Speak in an accent for the next 10 minutes",
                    "Let someone go through your search history",
                    "Eat a spoonful of something spicy",
                    "Do a silly dance and record it",
                    "Send a voice note singing your favorite song",
                    "Let someone write a status on your phone",
                    "Do 20 jumping jacks",
                    "Speak only in questions for 5 minutes",
                    "Let someone style your hair however they want",
                    "Send the last photo in your camera roll"
                ];
                
                const randomDare = dares[Math.floor(Math.random() * dares.length)];
                
                await socket.sendMessage(sender, {
                    text: `🎯 *Dare*\n\n${randomDare}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'roll': {
                const sides = parseInt(args[0]) || 6;
                const result = Math.floor(Math.random() * sides) + 1;
                
                await socket.sendMessage(sender, {
                    text: `🎲 *Roll*\n\nYou rolled a ${result} (1-${sides})\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'flip': {
                const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
                
                await socket.sendMessage(sender, {
                    text: `🪙 *Coin Flip*\n\n${result}!\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'rps': {
                const choices = ['rock', 'paper', 'scissors'];
                const userChoice = args[0]?.toLowerCase();
                
                if (!choices.includes(userChoice)) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .rps <rock|paper|scissors>' }, { quoted: msg });
                }
                
                const botChoice = choices[Math.floor(Math.random() * choices.length)];
                
                let result;
                if (userChoice === botChoice) {
                    result = "It's a tie!";
                } else if (
                    (userChoice === 'rock' && botChoice === 'scissors') ||
                    (userChoice === 'paper' && botChoice === 'rock') ||
                    (userChoice === 'scissors' && botChoice === 'paper')
                ) {
                    result = "You win! 🎉";
                } else {
                    result = "Bot wins! 🤖";
                }
                
                await socket.sendMessage(sender, {
                    text: `✊✋✌️ *Rock Paper Scissors*\n\nYou: ${userChoice}\nBot: ${botChoice}\n\n${result}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case '8ball': {
                const responses = [
                    "It is certain", "It is decidedly so", "Without a doubt", "Yes definitely",
                    "You may rely on it", "As I see it, yes", "Most likely", "Outlook good",
                    "Yes", "Signs point to yes", "Reply hazy, try again", "Ask again later",
                    "Better not tell you now", "Cannot predict now", "Concentrate and ask again",
                    "Don't count on it", "My reply is no", "My sources say no", "Outlook not so good",
                    "Very doubtful"
                ];
                
                const question = args.join(' ');
                const response = responses[Math.floor(Math.random() * responses.length)];
                
                await socket.sendMessage(sender, {
                    text: `🎱 *Magic 8-Ball*\n\nQuestion: ${question || 'No question asked'}\n\nAnswer: ${response}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'rate': {
                const target = args.join(' ') || 'you';
                const rating = (Math.random() * 10).toFixed(1);
                
                await socket.sendMessage(sender, {
                    text: `⭐ *Rate*\n\nI rate ${target} ${rating}/10\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'ship': {
                const users = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                
                if (users.length < 2) {
                    return await socket.sendMessage(sender, { text: '❌ Mention 2 users to ship\n\nExample: .ship @user1 @user2' }, { quoted: msg });
                }
                
                const percentage = Math.floor(Math.random() * 100) + 1;
                const user1 = users[0].split('@')[0];
                const user2 = users[1].split('@')[0];
                
                let comment;
                if (percentage < 20) comment = "Not meant to be 💔";
                else if (percentage < 40) comment = "Maybe with some work 🤔";
                else if (percentage < 60) comment = "There's potential! 💫";
                else if (percentage < 80) comment = "Great match! 💕";
                else comment = "Perfect couple! 💑";
                
                await socket.sendMessage(sender, {
                    text: `💘 *Ship*\n\n${user1} ❤️ ${user2}\n\nCompatibility: ${percentage}%\n${comment}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              // ==================== UTILITY COMMANDS ====================
              case 'time': {
                const timezone = args[0] || 'Africa/Harare';
                
                try {
                    const time = moment().tz(timezone).format('HH:mm:ss');
                    const date = moment().tz(timezone).format('YYYY-MM-DD');
                    
                    await socket.sendMessage(sender, {
                        text: `🕐 *Time*\n\n📅 Date: ${date}\n⏰ Time: ${time}\n🌍 Timezone: ${timezone}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Invalid timezone' }, { quoted: msg });
                }
                break;
              }

              case 'date': {
                const timezone = args[0] || 'Africa/Harare';
                
                try {
                    const date = moment().tz(timezone).format('dddd, MMMM Do, YYYY');
                    
                    await socket.sendMessage(sender, {
                        text: `📅 *Date*\n\n${date}\n🌍 Timezone: ${timezone}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Invalid timezone' }, { quoted: msg });
                }
                break;
              }

              case 'reminder': {
                const time = parseInt(args[0]);
                const message = args.slice(1).join(' ');
                
                if (!time || !message) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .reminder <minutes> <message>\n\nExample: .reminder 5 Check the oven' }, { quoted: msg });
                }
                
                await socket.sendMessage(sender, {
                    text: `⏰ *Reminder Set*\n\nI'll remind you in ${time} minutes:\n"${message}"\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                
                setTimeout(async () => {
                    try {
                        await socket.sendMessage(sender, {
                            text: `⏰ *Reminder!*\n\n${message}\n\n> M O O N  𝗫 𝗠 𝗗`
                        });
                    } catch (error) {
                        console.error('Failed to send reminder:', error);
                    }
                }, time * 60 * 1000);
                break;
              }

              case 'note': {
                const action = args[0];
                const noteContent = args.slice(1).join(' ');
                
                if (!action) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .note <add|list|delete> <content>\n\nExample: .note add Buy milk' }, { quoted: msg });
                }
                
                const notesPath = path.join(SESSION_BASE_PATH, `notes_${sanitizedNumber}.json`);
                let notes = [];
                
                if (fs.existsSync(notesPath)) {
                    notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
                }
                
                if (action === 'add') {
                    if (!noteContent) {
                        return await socket.sendMessage(sender, { text: '❌ Please provide note content' }, { quoted: msg });
                    }
                    
                    notes.push({
                        id: Date.now(),
                        content: noteContent,
                        date: new Date().toISOString()
                    });
                    
                    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
                    await socket.sendMessage(sender, { text: '✅ Note added successfully' }, { quoted: msg });
                    
                } else if (action === 'list') {
                    if (notes.length === 0) {
                        return await socket.sendMessage(sender, { text: '📝 No notes found' }, { quoted: msg });
                    }
                    
                    const notesList = notes.map((note, i) => 
                        `${i + 1}. ${note.content}\n   📅 ${new Date(note.date).toLocaleString()}`
                    ).join('\n\n');
                    
                    await socket.sendMessage(sender, {
                        text: `📝 *Your Notes*\n\n${notesList}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                    
                } else if (action === 'delete') {
                    const index = parseInt(noteContent) - 1;
                    
                    if (isNaN(index) || index < 0 || index >= notes.length) {
                        return await socket.sendMessage(sender, { text: '❌ Invalid note number' }, { quoted: msg });
                    }
                    
                    notes.splice(index, 1);
                    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
                    await socket.sendMessage(sender, { text: '✅ Note deleted successfully' }, { quoted: msg });
                    
                } else {
                    await socket.sendMessage(sender, { text: '❌ Invalid action. Use: add, list, or delete' }, { quoted: msg });
                }
                break;
              }

              case 'ttp': {
                const text = args.join(' ');
                
                if (!text) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .ttp <text>\n\nExample: .ttp Hello' }, { quoted: msg });
                }
                
                try {
                    const apiUrl = `https://api.popcat.xyz/texttoimage?text=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: apiUrl },
                        caption: `📝 *Text to Image*\n\n${text}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create text image' }, { quoted: msg });
                }
                break;
              }

              case 'attp': {
                const text = args.join(' ');
                
                if (!text) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .attp <text>\n\nExample: .attp Hello' }, { quoted: msg });
                }
                
                try {
                    const apiUrl = `https://api.popcat.xyz/attp?text=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(sender, {
                        sticker: { url: apiUrl }
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create animated text' }, { quoted: msg });
                }
                break;
              }

              // ==================== SEARCH COMMANDS ====================
              case 'google': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .google <search_query>\n\nExample: .google how to cook pasta' }, { quoted: msg });
                }
                
                try {
                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
                    
                    await socket.sendMessage(sender, {
                        text: `🔍 *Google Search*\n\nQuery: ${query}\n\n🔗 [Click here to search](${searchUrl})\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Search failed' }, { quoted: msg });
                }
                break;
              }

              case 'youtube': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .youtube <search_query>\n\nExample: .youtube funny cats' }, { quoted: msg });
                }
                
                try {
                    const yts = require('yt-search');
                    const search = await yts(query);
                    
                    if (!search.videos.length) {
                        return await socket.sendMessage(sender, { text: '❌ No results found' }, { quoted: msg });
                    }
                    
                    const video = search.videos[0];
                    
                    await socket.sendMessage(sender, {
                        text: `🎬 *YouTube Search*\n\n📺 Title: ${video.title}\n⏱️ Duration: ${video.timestamp}\n👀 Views: ${video.views}\n📅 Uploaded: ${video.ago}\n👤 Channel: ${video.author.name}\n\n🔗 Link: ${video.url}\n\n> M O O N  𝗫 𝗠 𝗗`,
                        contextInfo: {
                            externalAdReply: {
                                title: video.title,
                                body: video.author.name,
                                thumbnailUrl: video.thumbnail,
                                sourceUrl: video.url,
                                mediaType: 1,
                                showAdAttribution: true
                            }
                        }
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Search failed' }, { quoted: msg });
                }
                break;
              }

              case 'github': {
                const username = args[0];
                
                if (!username) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .github <username>\n\nExample: .github facebook' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.github.com/users/${username}`);
                    const user = response.data;
                    
                    const githubText = `
🐙 *GitHub Profile*

👤 *Name:* ${user.name || user.login}
🆔 *Username:* ${user.login}
📝 *Bio:* ${user.bio || 'No bio'}
📍 *Location:* ${user.location || 'Unknown'}
🔗 *Blog:* ${user.blog || 'None'}
📊 *Repositories:* ${user.public_repos}
👥 *Followers:* ${user.followers}
🤝 *Following:* ${user.following}
📅 *Joined:* ${new Date(user.created_at).toLocaleDateString()}
🔗 *Profile:* ${user.html_url}

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, {
                        image: { url: user.avatar_url },
                        caption: githubText
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ User not found' }, { quoted: msg });
                }
                break;
              }

              case 'npm': {
                const packageName = args[0];
                
                if (!packageName) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .npm <package_name>\n\nExample: .npm express' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://registry.npmjs.org/${packageName}`);
                    const pkg = response.data;
                    const latest = pkg.versions[pkg['dist-tags'].latest];
                    
                    const npmText = `
📦 *NPM Package*

📦 *Name:* ${pkg.name}
📝 *Description:* ${pkg.description || 'No description'}
🏷️ *Version:* ${pkg['dist-tags'].latest}
👤 *Author:* ${pkg.author?.name || 'Unknown'}
📜 *License:* ${latest.license || 'Unknown'}
🔗 *Homepage:* ${pkg.homepage || 'None'}
📥 *Downloads:* ${pkg.time ? Object.keys(pkg.time).length : 'N/A'}

> M O O N  𝗫 𝗠 𝗗
                    `.trim();
                    
                    await socket.sendMessage(sender, { text: npmText }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Package not found' }, { quoted: msg });
                }
                break;
              }

              // ==================== DOWNLOAD COMMANDS ====================
              case 'img': {
                const query = args.join(' ');
                
                if (!query) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .img <search_query>\n\nExample: .img cute cat' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1`, {
                        headers: { 'Authorization': '563492ad6f91700001000001' }
                    });
                    
                    if (!response.data.photos.length) {
                        return await socket.sendMessage(sender, { text: '❌ No images found' }, { quoted: msg });
                    }
                    
                    const image = response.data.photos[0];
                    
                    await socket.sendMessage(sender, {
                        image: { url: image.src.large },
                        caption: `🖼️ *Image Search*\n\n📸 Photographer: ${image.photographer}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Image search failed' }, { quoted: msg });
                }
                break;
              }

              case 'wallpaper': {
                const query = args.join(' ') || 'nature';
                
                try {
                    const response = await axios.get(`https://source.unsplash.com/800x600/?${encodeURIComponent(query)}`);
                    
                    await socket.sendMessage(sender, {
                        image: { url: response.request.res.responseUrl },
                        caption: `🖼️ *Wallpaper*\n\nQuery: ${query}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch wallpaper' }, { quoted: msg });
                }
                break;
              }

              case 'gdrive': {
                const url = args[0];
                
                if (!url || !url.includes('drive.google.com')) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .gdrive <google_drive_url>\n\nExample: .gdrive https://drive.google.com/file/d/...' }, { quoted: msg });
                }
                
                try {
                    const fileId = url.match(/\/d\/(.+?)\//)?.[1];
                    if (!fileId) {
                        return await socket.sendMessage(sender, { text: '❌ Invalid Google Drive URL' }, { quoted: msg });
                    }
                    
                    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                    
                    await socket.sendMessage(sender, {
                        text: `📁 *Google Drive*\n\n🔗 Download Link: ${downloadUrl}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to process Google Drive link' }, { quoted: msg });
                }
                break;
              }

              case 'mediafire': {
                const url = args[0];
                
                if (!url || !url.includes('mediafire.com')) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .mediafire <mediafire_url>\n\nExample: .mediafire https://www.mediafire.com/file/...' }, { quoted: msg });
                }
                
                try {
                    const response = await axios.get(url);
                    const $ = cheerio.load(response.data);
                    const downloadLink = $('a#downloadButton').attr('href');
                    const filename = $('div.filename').text().trim();
                    const filesize = $('div.filesize').text().trim();
                    
                    if (!downloadLink) {
                        return await socket.sendMessage(sender, { text: '❌ Failed to extract download link' }, { quoted: msg });
                    }
                    
                    await socket.sendMessage(sender, {
                        text: `📁 *MediaFire*\n\n📄 Filename: ${filename}\n📊 Size: ${filesize}\n🔗 Download: ${downloadLink}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to process MediaFire link' }, { quoted: msg });
                }
                break;
              }

              // ==================== MODERATION COMMANDS ====================
              case 'antilink': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                const action = args[0];
                
                if (action === 'on') {
                    await socket.sendMessage(sender, { text: '✅ Anti-link enabled' }, { quoted: msg });
                } else if (action === 'off') {
                    await socket.sendMessage(sender, { text: '✅ Anti-link disabled' }, { quoted: msg });
                } else {
                    await socket.sendMessage(sender, { text: '❌ Usage: .antilink <on|off>' }, { quoted: msg });
                }
                break;
              }

              case 'antispam': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                const action = args[0];
                
                if (action === 'on') {
                    await socket.sendMessage(sender, { text: '✅ Anti-spam enabled' }, { quoted: msg });
                } else if (action === 'off') {
                    await socket.sendMessage(sender, { text: '✅ Anti-spam disabled' }, { quoted: msg });
                } else {
                    await socket.sendMessage(sender, { text: '❌ Usage: .antispam <on|off>' }, { quoted: msg });
                }
                break;
              }

              case 'welcome': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                const action = args[0];
                
                if (action === 'on') {
                    await socket.sendMessage(sender, { text: '✅ Welcome messages enabled' }, { quoted: msg });
                } else if (action === 'off') {
                    await socket.sendMessage(sender, { text: '✅ Welcome messages disabled' }, { quoted: msg });
                } else {
                    await socket.sendMessage(sender, { text: '❌ Usage: .welcome <on|off>' }, { quoted: msg });
                }
                break;
              }

              case 'goodbye': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                const action = args[0];
                
                if (action === 'on') {
                    await socket.sendMessage(sender, { text: '✅ Goodbye messages enabled' }, { quoted: msg });
                } else if (action === 'off') {
                    await socket.sendMessage(sender, { text: '✅ Goodbye messages disabled' }, { quoted: msg });
                } else {
                    await socket.sendMessage(sender, { text: '❌ Usage: .goodbye <on|off>' }, { quoted: msg });
                }
                break;
              }

              // ==================== OWNER COMMANDS ====================
              case 'broadcast': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                const message = args.join(' ');
                
                if (!message) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .broadcast <message>' }, { quoted: msg });
                }
                
                try {
                    const groups = await socket.groupFetchAllParticipating();
                    let success = 0;
                    let failed = 0;
                    
                    for (const groupId of Object.keys(groups)) {
                        try {
                            await socket.sendMessage(groupId, { text: message });
                            success++;
                            await delay(1000);
                        } catch (error) {
                            failed++;
                        }
                    }
                    
                    await socket.sendMessage(sender, {
                        text: `📢 *Broadcast Complete*\n\n✅ Success: ${success}\n❌ Failed: ${failed}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Broadcast failed' }, { quoted: msg });
                }
                break;
              }

              case 'clearchat': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                try {
                    await socket.chatModify({ delete: true, lastMessages: [] }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat cleared' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to clear chat' }, { quoted: msg });
                }
                break;
              }

              case 'leave': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }
                
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only admins can use this command' }, { quoted: msg });
                }
                
                try {
                    await socket.groupLeave(from);
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to leave group' }, { quoted: msg });
                }
                break;
              }

              case 'join': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }
                
                const inviteCode = args[0];
                
                if (!inviteCode) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .join <group_invite_code>' }, { quoted: msg });
                }
                
                try {
                    const response = await socket.groupAcceptInvite(inviteCode);
                    await socket.sendMessage(sender, { text: `✅ Successfully joined group: ${response}` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to join group' }, { quoted: msg });
                }
                break;
              }

              // ==================== ADVANCED FEATURES ====================
              case 'help': {
                const helpText = `
📚 *M O O N  𝗫 𝗠 𝗗 Help Guide*

🤖 *Basic Commands:*
• .menu - Show interactive menu
• .alive - Check bot status
• .ping - Test response speed
• .ai - Chat with AI

👥 *Group Commands:*
• .grouplist - List all groups
• .groupinfo - Get group details
• .tagall - Mention everyone
• .kick - Remove users (admin)
• .promote - Make admin (admin)

🎬 *Downloads:*
• .song - Download music
• .tiktok - Download TikTok
• .fb - Download Facebook
• .ig - Download Instagram
• .apk - Download apps

🛠️ *Tools:*
• .weather - Weather info
• .translate - Translate text
• .calc - Calculator
• .qr - Generate QR code
• .shorten - Shorten URL

🎌 *Anime:*
• .anime - Search anime
• .manga - Search manga
• .waifu - Random waifu
• .neko - Random neko

🎮 *Fun:*
• .truth / .dare - Game
• .roll - Dice
• .flip - Coin
• .rps - Rock Paper Scissors

📝 *Notes:*
• .note add <text> - Add note
• .note list - List notes
• .note delete <num> - Delete note

💡 *Tips:*
• Use .menu for interactive navigation
• Reply to messages for context
• Admin commands require permissions

> M O O N  𝗫 𝗠 𝗗
                `.trim();

                await socket.sendMessage(sender, { text: helpText }, { quoted: msg });
                break;
              }

              case 'stats': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const days = Math.floor(uptime / 86400);
                const hours = Math.floor((uptime % 86400) / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = uptime % 60;

                const statsText = `
📊 *Bot Statistics*

⏱️ *Uptime:*
${days}d ${hours}h ${minutes}m ${seconds}s

👥 *Active Sessions:* ${activeSockets.size}

📱 *Platform:* WhatsApp Web

🔧 *Features:*
• 100+ Commands
• 15 Categories
• MongoDB Storage
• Auto Reconnect
• Newsletter Integration

🌐 *Status:* Online

> M O O N  𝗫 𝗠 𝗗
                `.trim();

                await socket.sendMessage(sender, { text: statsText }, { quoted: msg });
                break;
              }

              case 'settings': {
                const settingsText = `
⚙️ *Bot Settings*

📌 *Current Configuration:*

🔔 *Notifications:* Enabled
📰 *Newsletter:* Auto-follow
👁️ *Status View:* Auto-view
❤️ *Status Like:* Auto-like
🎤 *Recording:* Auto-recording

📝 *To change settings, use:*
.update-config (requires OTP)

> M O O N  𝗫 𝗠 𝗗
                `.trim();

                await socket.sendMessage(sender, { text: settingsText }, { quoted: msg });
                break;
              }

              case 'sticker': {
                if (!msg.message?.imageMessage && !msg.message?.videoMessage) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image or video to create sticker' }, { quoted: msg });
                }

                try {
                    const media = msg.message.imageMessage || msg.message.videoMessage;
                    const stream = await downloadContentFromMessage(media, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    await socket.sendMessage(sender, {
                        sticker: buffer
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: msg });
                }
                break;
              }

              case 'take': {
                if (!msg.message?.imageMessage && !msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a sticker or image' }, { quoted: msg });
                }

                const packname = args[0] || 'M O O N  𝗫 𝗠 𝗗';
                const author = args[1] || 'Sticker';

                try {
                    let media;
                    if (msg.message.imageMessage) {
                        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    } else if (msg.quoted) {
                        media = await downloadContentFromMessage(msg.quoted.message.stickerMessage || msg.quoted.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of media) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    }

                    const sticker = await new Jimp.read(media);
                    const buff = await sticker.getBufferAsync(Jimp.MIME_PNG);

                    await socket.sendMessage(sender, {
                        sticker: buff,
                        packName: packname,
                        packPublish: author
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: msg });
                }
                break;
              }

              case 'emojimix': {
                if (args.length < 2) {
                    return await socket.sendMessage(sender, { text: '❌ Provide 2 emojis\n\nExample: .emojimix 😎😂' }, { quoted: msg });
                }

                try {
                    const emoji1 = args[0];
                    const emoji2 = args[1];
                    const apiUrl = `https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(emoji1)}_${encodeURIComponent(emoji2)}`;

                    const response = await axios.get(apiUrl);
                    const results = response.data.results;

                    if (!results || results.length === 0) {
                        throw new Error('No emoji mix found');
                    }

                    const emojiUrl = results[0].url;

                    await socket.sendMessage(sender, {
                        sticker: { url: emojiUrl }
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to mix emojis' }, { quoted: msg });
                }
                break;
              }

              case 'toimage': {
                if (!msg.quoted || !msg.quoted.message?.stickerMessage) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a sticker' }, { quoted: msg });
                }

                try {
                    const stream = await downloadContentFromMessage(msg.quoted.message.stickerMessage, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    const image = await Jimp.read(buffer);
                    const buff = await image.getBufferAsync(Jimp.MIME_JPEG);

                    await socket.sendMessage(sender, {
                        image: buff,
                        caption: '> M O O N  𝗫 𝗠 𝗗'
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to convert sticker to image' }, { quoted: msg });
                }
                break;
              }

              case 'tovideo': {
                if (!msg.quoted || !msg.quoted.message?.stickerMessage) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an animated sticker' }, { quoted: msg });
                }

                try {
                    const stream = await downloadContentFromMessage(msg.quoted.message.stickerMessage, 'sticker');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    await socket.sendMessage(sender, {
                        video: buffer,
                        gifPlayback: true,
                        caption: '> M O O N  𝗫 𝗠 𝗗'
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to convert sticker to video' }, { quoted: msg });
                }
                break;
              }

              case 'removebg': {
                if (!msg.message?.imageMessage && !msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image' }, { quoted: msg });
                }

                try {
                    let media;
                    if (msg.message.imageMessage) {
                        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    } else if (msg.quoted) {
                        const stream = await downloadContentFromMessage(msg.quoted.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    }

                    const FormData = require('form-data');
                    const formData = new FormData();
                    formData.append('image_file', media, 'image.png');
                    formData.append('size', 'auto');

                    const response = await axios.post('https://api.remove.bg/v1.0/removebg', formData, {
                        headers: {
                            ...formData.getHeaders(),
                            'X-Api-Key': config.REMOVEBG_API_KEY || 'demo'
                        },
                        responseType: 'arraybuffer'
                    });

                    await socket.sendMessage(sender, {
                        image: response.data,
                        caption: '✅ Background removed\n> M O O N  𝗫 𝗠 𝗗'
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to remove background. Check API key.' }, { quoted: msg });
                }
                break;
              }

              case 'ocr': {
                if (!msg.message?.imageMessage && !msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image with text' }, { quoted: msg });
                }

                try {
                    let media;
                    if (msg.message.imageMessage) {
                        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    } else if (msg.quoted) {
                        const stream = await downloadContentFromMessage(msg.quoted.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    }

                    const FormData = require('form-data');
                    const formData = new FormData();
                    formData.append('file', media, 'image.png');

                    const response = await axios.post('https://api.ocr.space/parse/image', formData, {
                        headers: {
                            ...formData.getHeaders(),
                            'apikey': config.OCR_API_KEY || 'helloworld'
                        }
                    });

                    if (response.data.IsErroredOnProcessing) {
                        throw new Error('OCR processing failed');
                    }

                    const text = response.data.ParsedResults[0].ParsedText;

                    await socket.sendMessage(sender, {
                        text: `📝 *Extracted Text*\n\n${text}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to extract text from image' }, { quoted: msg });
                }
                break;
              }

              case 'url': {
                if (!msg.message?.imageMessage && !msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image' }, { quoted: msg });
                }

                try {
                    let media;
                    if (msg.message.imageMessage) {
                        const stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    } else if (msg.quoted) {
                        const stream = await downloadContentFromMessage(msg.quoted.message.imageMessage, 'image');
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }
                        media = buffer;
                    }

                    const FormData = require('form-data');
                    const formData = new FormData();
                    formData.append('file', media, 'image.png');

                    const uploadResponse = await axios.post('https://telegra.ph/upload', formData, {
                        headers: { ...formData.getHeaders() }
                    });

                    const imageUrl = `https://telegra.ph${uploadResponse.data[0].src}`;

                    await socket.sendMessage(sender, {
                        text: `🔗 *Image URL*\n\n${imageUrl}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to upload image' }, { quoted: msg });
                }
                break;
              }

              case 'telegraph': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide text or URL\n\nExample: .telegraph https://example.com' }, { quoted: msg });
                }

                try {
                    const input = args.join(' ');
                    let content;

                    if (input.startsWith('http')) {
                        const response = await axios.get(input);
                        const $ = cheerio.load(response.data);
                        content = $('body').text().substring(0, 50000);
                    } else {
                        content = input;
                    }

                    const telegraphResponse = await axios.post('https://telegra.ph/createPage', {
                        title: 'M O O N  𝗫 𝗠 𝗗 Article',
                        author_name: 'M O O N  𝗫 𝗠 𝗗',
                        content: content.replace(/\n/g, '<br>')
                    });

                    await socket.sendMessage(sender, {
                        text: `📄 *Telegraph Article*\n\n🔗 ${telegraphResponse.data.url}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create telegraph article' }, { quoted: msg });
                }
                break;
              }

              case 'ss': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a URL\n\nExample: .ss https://example.com' }, { quoted: msg });
                }

                try {
                    const url = args[0];
                    const screenshotUrl = `https://api.apiflash.com/v1/urltoimage?access_key=${config.SCREENSHOT_API_KEY || 'demo'}&url=${encodeURIComponent(url)}&fresh=true&quality=100`;

                    await socket.sendMessage(sender, {
                        image: { url: screenshotUrl },
                        caption: `📸 *Screenshot*\n\n🔗 ${url}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to take screenshot' }, { quoted: msg });
                }
                break;
              }

              case 'carbon': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide code\n\nExample: .carbon console.log("Hello")' }, { quoted: msg });
                }

                try {
                    const code = args.join(' ');
                    const carbonUrl = `https://carbon.now.sh/?code=${encodeURIComponent(code)}&theme=monokai&backgroundColor=rgba(171, 184, 195, 1)`;

                    await socket.sendMessage(sender, {
                        text: `🎨 *Carbon Code*\n\n🔗 ${carbonUrl}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate carbon code' }, { quoted: msg });
                }
                break;
              }

              case 'pastebin': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide text\n\nExample: .pastebin Your text here' }, { quoted: msg });
                }

                try {
                    const text = args.join(' ');
                    const response = await axios.post('https://pastebin.com/api/api_post.php', new URLSearchParams({
                        api_dev_key: config.PASTEBIN_API_KEY || 'demo',
                        api_option: 'paste',
                        api_paste_code: text,
                        api_paste_name: 'M O O N  𝗫 𝗠 𝗗 Paste',
                        api_paste_private: '0'
                    }));

                    if (response.data.startsWith('Bad API request')) {
                        throw new Error('Pastebin API error');
                    }

                    await socket.sendMessage(sender, {
                        text: `📋 *Pastebin*\n\n🔗 ${response.data}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create pastebin' }, { quoted: msg });
                }
                break;
              }

              case 'tempmail': {
                try {
                    const response = await axios.get('https://temp-mail.org/api/v1/inbox/');
                    const mail = response.data[0];

                    await socket.sendMessage(sender, {
                        text: `📧 *Temporary Email*\n\n📧 Email: ${mail.mail}\n🔑 Domain: ${mail.domain}\n⏰ Valid until: ${new Date(mail.valid_till * 1000).toLocaleString()}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate temporary email' }, { quoted: msg });
                }
                break;
              }

              case 'checkmail': {
                try {
                    const response = await axios.get('https://temp-mail.org/api/v1/inbox/');
                    const mails = response.data;

                    if (mails.length === 0) {
                        return await socket.sendMessage(sender, { text: '📭 No emails found' }, { quoted: msg });
                    }

                    const mailList = mails.slice(0, 5).map((m, i) =>
                        `${i + 1}. From: ${m.mail_from}\n   Subject: ${m.subject}\n   Date: ${new Date(m.date * 1000).toLocaleString()}`
                    ).join('\n\n');

                    await socket.sendMessage(sender, {
                        text: `📬 *Inbox*\n\n${mailList}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to check emails' }, { quoted: msg });
                }
                break;
              }

              case 'ip': {
                try {
                    const response = await axios.get('https://api.ipify.org?format=json');
                    const ip = response.data.ip;

                    const geoResponse = await axios.get(`https://ipapi.co/${ip}/json/`);
                    const geo = geoResponse.data;

                    await socket.sendMessage(sender, {
                        text: `🌐 *IP Information*\n\n🔢 IP: ${ip}\n🌍 Country: ${geo.country_name}\n🏙️ City: ${geo.city}\n📍 Region: ${geo.region}\n🏢 ISP: ${geo.org}\n⏰ Timezone: ${geo.timezone}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to get IP information' }, { quoted: msg });
                }
                break;
              }

              case 'whois': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a domain\n\nExample: .whois google.com' }, { quoted: msg });
                }

                try {
                    const domain = args[0];
                    const response = await axios.get(`https://whoisjson.com/api/v1/whois?domain_name=${domain}`);

                    if (response.data.error) {
                        throw new Error('Domain not found');
                    }

                    const whois = response.data;
                    await socket.sendMessage(sender, {
                        text: `🔍 *WHOIS Information*\n\n📛 Domain: ${whois.domain_name}\n📅 Created: ${whois.creation_date}\n⏰ Expires: ${whois.expiration_date}\n🏢 Registrar: ${whois.registrar.name}\n📧 Email: ${whois.registrar.email}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to get WHOIS information' }, { quoted: msg });
                }
                break;
              }

              case 'speedtest': {
                try {
                    await socket.sendMessage(sender, { text: '🚀 Running speed test... Please wait...' }, { quoted: msg });

                    const response = await axios.get('https://speed.cloudflare.com/__down?bytes=10000000');
                    const downloadTime = response.config.timeout || 5000;
                    const downloadSpeed = (10 / (downloadTime / 1000)).toFixed(2);

                    await socket.sendMessage(sender, {
                        text: `🚀 *Speed Test Results*\n\n⬇️ Download Speed: ${downloadSpeed} MB/s\n⏱️ Test Duration: ${downloadTime}ms\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to run speed test' }, { quoted: msg });
                }
                break;
              }

              case 'meme': {
                try {
                    const response = await axios.get('https://meme-api.com/gimme');
                    const meme = response.data;

                    await socket.sendMessage(sender, {
                        image: { url: meme.url },
                        caption: `😂 *Meme*\n\n📛 Title: ${meme.title}\n👤 Author: ${meme.author}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch meme' }, { quoted: msg });
                }
                break;
              }

              case 'quoteimg': {
                try {
                    const response = await axios.get('https://api.quotable.io/random');
                    const quote = response.data;

                    const quoteUrl = `https://quickchart.io/quote?text=${encodeURIComponent(quote.content)}&author=${encodeURIComponent(quote.author)}&format=png&width=800&height=400&mode=fit`;

                    await socket.sendMessage(sender, {
                        image: { url: quoteUrl },
                        caption: `💭 *Quote Image*\n\n"${quote.content}"\n\n— ${quote.author}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate quote image' }, { quoted: msg });
                }
                break;
              }

              case 'text2img': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide text\n\nExample: .text2img Hello World' }, { quoted: msg });
                }

                try {
                    const text = args.join(' ');
                    const imageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}`;

                    await socket.sendMessage(sender, {
                        image: { url: imageUrl },
                        caption: `📝 *Text to Image*\n\n${text}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to generate image' }, { quoted: msg });
                }
                break;
              }

              case 'poll': {
                if (args.length < 3) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .poll <question> | <option1> | <option2> | ...\n\nExample: .poll Best language? | Python | JavaScript | Java' }, { quoted: msg });
                }

                try {
                    const input = args.join(' ');
                    const parts = input.split('|').map(p => p.trim());

                    if (parts.length < 3) {
                        throw new Error('Need at least question and 2 options');
                    }

                    const question = parts[0];
                    const options = parts.slice(1);

                    await socket.sendMessage(from, {
                        poll: {
                            name: question,
                            values: options,
                            selectableCount: 1
                        }
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create poll' }, { quoted: msg });
                }
                break;
              }

              case 'list': {
                if (args.length < 3) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .list <title> | <row1> | <row2> | ...\n\nExample: .list Menu | Pizza | Burger | Fries' }, { quoted: msg });
                }

                try {
                    const input = args.join(' ');
                    const parts = input.split('|').map(p => p.trim());

                    if (parts.length < 2) {
                        throw new Error('Need at least title and 1 row');
                    }

                    const title = parts[0];
                    const rows = parts.slice(1).map((r, i) => ({
                        title: r,
                        rowId: `${config.PREFIX}list_${i}`
                    }));

                    await socket.sendMessage(from, {
                        text: title,
                        footer: 'M O O N  𝗫 𝗠 𝗗',
                        buttonText: 'View Options',
                        sections: [{ title, rows }]
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create list' }, { quoted: msg });
                }
                break;
              }

              case 'button': {
                if (args.length < 3) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .button <text> | <button1> | <button2>\n\nExample: .button Choose | Yes | No' }, { quoted: msg });
                }

                try {
                    const input = args.join(' ');
                    const parts = input.split('|').map(p => p.trim());

                    if (parts.length < 3) {
                        throw new Error('Need text and at least 2 buttons');
                    }

                    const text = parts[0];
                    const buttons = parts.slice(1).map((b, i) => ({
                        buttonId: `btn_${i}`,
                        buttonText: { displayText: b },
                        type: 1
                    }));

                    await socket.sendMessage(from, {
                        text,
                        footer: 'M O O N  𝗫 𝗠 𝗗',
                        buttons
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to create buttons' }, { quoted: msg });
                }
                break;
              }

              case 'react': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide an emoji\n\nExample: .react 😂' }, { quoted: msg });
                }

                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message' }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(from, {
                        react: { text: args[0], key: msg.quoted.key }
                    });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to react' }, { quoted: msg });
                }
                break;
              }

              case 'delete': {
                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message to delete' }, { quoted: msg });
                }

                if (!msg.quoted.key.fromMe && !isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can delete others\' messages' }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(from, { delete: msg.quoted.key });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to delete message' }, { quoted: msg });
                }
                break;
              }

              case 'edit': {
                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message to edit' }, { quoted: msg });
                }

                if (!msg.quoted.key.fromMe) {
                    return await socket.sendMessage(sender, { text: '❌ Can only edit your own messages' }, { quoted: msg });
                }

                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide new text' }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(from, {
                        text: args.join(' '),
                        edit: msg.quoted.key
                    });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to edit message' }, { quoted: msg });
                }
                break;
              }

              case 'forwardall': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }

                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message to forward' }, { quoted: msg });
                }

                try {
                    const groups = await socket.groupFetchAllParticipating();
                    let successCount = 0;

                    for (const group of Object.values(groups)) {
                        try {
                            await socket.sendMessage(group.id, msg.quoted.message, { forwardingScore: 999, isForwarded: true });
                            successCount++;
                            await delay(1000);
                        } catch (error) {
                            console.error(`Failed to forward to ${group.id}`);
                        }
                    }

                    await socket.sendMessage(sender, {
                        text: `✅ Forwarded to ${successCount}/${Object.keys(groups).length} groups`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to forward message' }, { quoted: msg });
                }
                break;
              }

              case 'spam': {
                if (!isOwner) {
                    return await socket.sendMessage(sender, { text: '❌ Only owner can use this command' }, { quoted: msg });
                }

                if (args.length < 2) {
                    return await socket.sendMessage(sender, { text: '❌ Usage: .spam <count> <message>\n\nExample: .spam 5 Hello' }, { quoted: msg });
                }

                try {
                    const count = parseInt(args[0]);
                    const message = args.slice(1).join(' ');

                    if (count > 50) {
                        return await socket.sendMessage(sender, { text: '❌ Maximum 50 messages' }, { quoted: msg });
                    }

                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(from, { text: message });
                        await delay(500);
                    }

                    await socket.sendMessage(sender, { text: `✅ Sent ${count} messages` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to spam' }, { quoted: msg });
                }
                break;
              }

              case 'blocklist': {
                try {
                    const blocked = await socket.fetchBlocklist();
                    const blockedList = blocked.map(b => b.split('@')[0]).join('\n');

                    await socket.sendMessage(sender, {
                        text: `🚫 *Blocked Users*\n\n${blockedList || 'No blocked users'}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch blocklist' }, { quoted: msg });
                }
                break;
              }

              case 'getid': {
                const target = msg.quoted ? msg.quoted.sender : sender;
                await socket.sendMessage(sender, {
                    text: `🆔 *User ID*\n\n${target}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'getjid': {
                if (!isGroup) {
                    return await socket.sendMessage(sender, { text: '❌ This command only works in groups' }, { quoted: msg });
                }

                await socket.sendMessage(sender, {
                    text: `🆔 *Group JID*\n\n${from}\n\n> M O O N  𝗫 𝗠 𝗗`
                }, { quoted: msg });
                break;
              }

              case 'profile': {
                try {
                    const ppUrl = await socket.profilePictureUrl(sender, 'image').catch(() => config.RCD_IMAGE_PATH);
                    const status = await socket.fetchStatus(sender).catch(() => ({ status: 'No status' }));

                    await socket.sendMessage(sender, {
                        image: { url: ppUrl },
                        caption: `👤 *Your Profile*\n\n📱 Number: ${sender.split('@')[0]}\n📝 Status: ${status.status}\n\n> M O O N  𝗫 𝗠 𝗗`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to fetch profile' }, { quoted: msg });
                }
                break;
              }

              case 'setstatus': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a status\n\nExample: .setstatus Hello World' }, { quoted: msg });
                }

                try {
                    await socket.updateProfileStatus(args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Status updated successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update status' }, { quoted: msg });
                }
                break;
              }

              case 'setnamebot': {
                if (!args[0]) {
                    return await socket.sendMessage(sender, { text: '❌ Provide a name\n\nExample: .setnamebot My Bot' }, { quoted: msg });
                }

                try {
                    await socket.updateProfileName(args.join(' '));
                    await socket.sendMessage(sender, { text: '✅ Bot name updated successfully' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update bot name' }, { quoted: msg });
                }
                break;
              }

              case 'setppbot': {
                if (!msg.message?.imageMessage) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to an image' }, { quoted: msg });
                }

                try {
                    const media = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of media) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    await socket.updateProfilePicture(jidNormalizedUser(socket.user.id), buffer);
                    await socket.sendMessage(sender, { text: '✅ Bot profile picture updated' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to update profile picture' }, { quoted: msg });
                }
                break;
              }

              case 'read': {
                if (!msg.quoted) {
                    return await socket.sendMessage(sender, { text: '❌ Reply to a message' }, { quoted: msg });
                }

                try {
                    await socket.chatModify({ markRead: true }, from);
                    await socket.readMessages([msg.quoted.key]);
                    await socket.sendMessage(sender, { text: '✅ Marked as read' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to mark as read' }, { quoted: msg });
                }
                break;
              }

              case 'unread': {
                try {
                    await socket.chatModify({ markRead: false }, from);
                    await socket.sendMessage(sender, { text: '✅ Marked as unread' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to mark as unread' }, { quoted: msg });
                }
                break;
              }

              case 'archive': {
                try {
                    await socket.chatModify({ archive: true }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat archived' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to archive chat' }, { quoted: msg });
                }
                break;
              }

              case 'unarchive': {
                try {
                    await socket.chatModify({ archive: false }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat unarchived' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unarchive chat' }, { quoted: msg });
                }
                break;
              }

              case 'pin': {
                try {
                    await socket.chatModify({ pin: true }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat pinned' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to pin chat' }, { quoted: msg });
                }
                break;
              }

              case 'unpin': {
                try {
                    await socket.chatModify({ pin: false }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat unpinned' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unpin chat' }, { quoted: msg });
                }
                break;
              }

              case 'mutechat': {
                const duration = args[0] ? parseInt(args[0]) : 1;

                try {
                    await socket.chatModify({ mute: duration * 86400000 }, from);
                    await socket.sendMessage(sender, { text: `✅ Chat muted for ${duration} day(s)` }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to mute chat' }, { quoted: msg });
                }
                break;
              }

              case 'unmutechat': {
                try {
                    await socket.chatModify({ mute: null }, from);
                    await socket.sendMessage(sender, { text: '✅ Chat unmuted' }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(sender, { text: '❌ Failed to unmute chat' }, { quoted: msg });
                }
                break;
              }


                case 'stopjadibot': case 'stoprent': {
                  const nmrnya = text ? text.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender
                  const onWa = await socket.onWhatsApp(nmrnya)
                  if (!onWa.length > 0) return await socket.sendMessage(sender, { text: 'The Number Is Not Registered On Whatsapp!' }, { quoted: msg })
                  await StopJadiBot(socket, nmrnya, msg)
                }
                break
                case 'listjadibot': case 'listrent': {
                  ListJadiBot(socket, msg)
                }
                break

                // Tools Menu
                case 'fetch': case 'get': {
                  if (!/^https?:\/\//.test(text)) return await socket.sendMessage(sender, { text: 'Start with http:// or https://' }, { quoted: msg })
                  try {
                    const res = await axios.get(isUrl(text) ? isUrl(text)[0] : text)
                    if (!/text|json|html|plain/.test(res.headers['content-type'])) {
                      await socket.sendMessage(sender, { text: text }, { quoted: msg })
                    } else await socket.sendMessage(sender, { text: util.format(res.data) }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: String(e) }, { quoted: msg })
                  }
                }
                break
                case 'toaud': case 'toaudio': {
                  if (!/video|audio/.test(mime)) return await socket.sendMessage(sender, { text: `Send/Reply Video/Audio What You Want To Make Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await quoted.download()
                  let audio = await toAudio(media, 'mp4')
                  await socket.sendMessage(sender, { audio: audio, mimetype: 'audio/mpeg' }, { quoted: msg })
                }
                break
                case 'tomp3': {
                  if (!/video|audio/.test(mime)) return await socket.sendMessage(sender, { text: `Send/Reply Video/Audio What You Want To Make Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await quoted.download()
                  let audio = await toAudio(media, 'mp4')
                  await socket.sendMessage(sender, { document: audio, mimetype: 'audio/mpeg', fileName: `Convert By Light Speed Mini Bot.mp3` }, { quoted: msg })
                }
                break
                case 'tovn': case 'toptt': case 'tovoice': {
                  if (!/video|audio/.test(mime)) return await socket.sendMessage(sender, { text: `Send/Reply Video/Audio What You Want To Make Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await quoted.download()
                  let audio = await toPTT(media, 'mp4')
                  await socket.sendMessage(sender, { audio: audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg })
                }
                break
                case 'togif': {
                  if (!/webp|video/.test(mime)) return await socket.sendMessage(sender, { text: `Reply Video/Stiker With Caption *${config.PREFIX}${command}*` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(quoted)
                  let ran = `./database/sampah/${getRandom('.gif')}`
                  exec(`convert ${media} ${ran}`, (err) => {
                    fs.unlinkSync(media)
                    if (err) return socket.sendMessage(sender, { text: 'Failed❗' }, { quoted: msg })
                    let buffer = fs.readFileSync(ran)
                    socket.sendMessage(sender, { video: buffer, gifPlayback: true }, { quoted: msg })
                    fs.unlinkSync(ran)
                  })
                }
                break
                case 'toimage': case 'toimg': {
                  if (!/webp|video/.test(mime)) return await socket.sendMessage(sender, { text: `Reply Video/Stiker With Caption *${config.PREFIX}${command}*` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(quoted)
                  let ran = `./database/sampah/${getRandom('.png')}`
                  exec(`convert ${media}[0] ${ran}`, (err) => {
                    fs.unlinkSync(media)
                    if (err) return socket.sendMessage(sender, { text: 'Failed❗' }, { quoted: msg })
                    let buffer = fs.readFileSync(ran)
                    socket.sendMessage(sender, { image: buffer }, { quoted: msg })
                    fs.unlinkSync(ran)
                  })
                }
                break
                case 'toptv': {
                  if (!/video/.test(mime)) return await socket.sendMessage(sender, { text: `Send/Reply Video Who Wants To Be PTV Message With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  if ((quoted ? quoted.type : type) === 'videoMessage') {
                    const anu = await quoted.download()
                    const message = await generateWAMessageContent({ video: anu }, { upload: socket.waUploadToServer })
                    await socket.relayMessage(from, { ptvMessage: message.videoMessage }, {})
                  } else await socket.sendMessage(sender, { text: 'Reply Video What You Want To Change To PTV Message!' }, { quoted: msg })
                }
                break
                case 'tourl': {
                  try {
                    if (/webp|video|sticker|audio|jpg|jpeg|png/.test(mime)) {
                      await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                      let media = await quoted.download()
                      let anu = await UguuSe(media)
                      await socket.sendMessage(sender, { text: 'Url : ' + anu.url }, { quoted: msg })
                    } else await socket.sendMessage(sender, { text: 'Send the media that you want to upload!' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server Uploader is offline!' }, { quoted: msg })
                  }
                }
                break
                case 'texttospech': case 'tts': case 'tospech': {
                  if (!text) return await socket.sendMessage(sender, { text: 'Which text do you want to convert to audio?' }, { quoted: msg })
                  let { tts } = require('./lib/tts')
                  let anu = await tts(text)
                  await socket.sendMessage(sender, { audio: anu, ptt: true, mimetype: 'audio/mpeg' }, { quoted: msg })
                }
                break
                case 'translate': case 'tr': {
                  if (text && text == 'list') {
                    let list_tr = `╭▰▱▰▱彡「 *Language Code* 」彡\n│• af : Afrikaans\n│• ar : Arab\n│• zh : Chinese\n│• en : English\n│• en-us : English (United States)\n│• fr : French\n│• de : German\n│• hi : Hindi\n│• hu : Hungarian\n│• is : Icelandic\n│• id : Indonesian\n│• it : Italian\n│• ja : Japanese\n│• ko : Korean\n│• la : Latin\n│• no : Norwegian\n│• pt : Portuguese\n│• pt-br : Portuguese (Brazil)\n│• ro : Romanian\n│• ru : Russian\n│• sr : Serbian\n│• es : Spanish\n│• sv : Swedish\n│• ta : Tamil\n│• th : Thai\n│• tr : Turkish\n│• vi : Vietnamese\n╰▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱▰▱彡`
                    await socket.sendMessage(sender, { text: list_tr }, { quoted: msg })
                  } else {
                    if (!quoted && (!text || !args[1])) return await socket.sendMessage(sender, { text: `Send/reply text with caption ${config.PREFIX}${command}` }, { quoted: msg })
                    let lang = args[0] ? args[0] : 'id'
                    let teks = args[1] ? args.slice(1).join(' ') : quoted.text
                    try {
                      let hasil = await translate(teks, { to: lang, autoCorrect: true })
                      await socket.sendMessage(sender, { text: `To : ${lang}\n${hasil[0]}` }, { quoted: msg })
                    } catch (e) {
                      await socket.sendMessage(sender, { text: `Language *${lang}* Not Found!\nPlease see list, ${config.PREFIX}${command} list` }, { quoted: msg })
                    }
                  }
                }
                break
                case 'toqr': case 'qr': {
                  if (!text) return await socket.sendMessage(sender, { text: `Convert Text to Qr with *${config.PREFIX}${command}* your text` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  await socket.sendMessage(sender, { image: { url: 'https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=' + text }, caption: 'Here it is' }, { quoted: msg })
                }
                break
                case 'tohd': case 'remini': case 'hd': {
                  if (/image/.test(mime)) {
                    try {
                      let media = await quoted.download()
                      let hasil = await remini(media, 'enhance')
                      await socket.sendMessage(sender, { image: hasil, caption: 'Done' }, { quoted: msg })
                    } catch (e) {
                      let media = await socket.downloadAndSaveMediaMessage(quoted)
                      let ran = `./database/sampah/${getRandom('.jpg')}`
                      const scaleFactor = isNaN(parseInt(text)) ? 4 : parseInt(text)
                      exec(`ffmpeg -i "${media}" -vf "scale=iw*${scaleFactor}:ih*${scaleFactor}:flags=lanczos" -q:v 1 "${ran}"`, async (err, stderr, stdout) => {
                        fs.unlinkSync(media)
                        if (err) return socket.sendMessage(sender, { text: String(err) }, { quoted: msg })
                        let buff = fs.readFileSync(ran)
                        await socket.sendMedia(from, buff, '', 'Done', msg)
                        fs.unlinkSync(ran)
                      })
                    }
                  } else await socket.sendMessage(sender, { text: `Send/Reply Image with format\nExample: ${config.PREFIX}${command}` }, { quoted: msg })
                }
                break
                case 'dehaze': case 'colorize': case 'colorfull': {
                  if (/image/.test(mime)) {
                    let media = await quoted.download()
                    remini(media, 'dehaze').then(a => {
                      socket.sendMessage(sender, { image: a, caption: 'Done' }, { quoted: msg })
                    }).catch(e => socket.sendMessage(sender, { text: 'Server is offline!' }, { quoted: msg }))
                  } else await socket.sendMessage(sender, { text: `Send/Reply Image with format\nExample: ${config.PREFIX}${command}` }, { quoted: msg })
                }
                break
                case 'hitamkan': case 'toblack': {
                  if (/image/.test(mime)) {
                    let media = await quoted.download()
                    hitamkan(media, 'hitam').then(a => {
                      socket.sendMessage(sender, { image: a, caption: 'Done' }, { quoted: msg })
                    }).catch(e => socket.sendMessage(sender, { text: 'Server is offline!' }, { quoted: msg }))
                  } else await socket.sendMessage(sender, { text: `Send/Reply Image with format\nExample: ${config.PREFIX}${command}` }, { quoted: msg })
                }
                break
                case 'ssweb': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} https://github.com/Light-Dev/Light-Speed-Mini-Bot` }, { quoted: msg })
                  try {
                    let anu = 'https://' + text.replace(/^https?:\/\//, '')
                    await socket.sendMessage(sender, { image: { url: 'https://image.thum.io/get/width/1900/crop/1000/fullpage/' + anu }, caption: 'Done' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is offline!' }, { quoted: msg })
                  }
                }
                break
                case 'readmore': {
                  let teks1 = text.split`|`[0] ? text.split`|`[0] : ''
                  let teks2 = text.split`|`[1] ? text.split`|`[1] : ''
                  await socket.sendMessage(sender, { text: teks1 + readmore + teks2 }, { quoted: msg })
                }
                break
                case 'getexif': {
                  if (!quoted) return await socket.sendMessage(sender, { text: `Reply sticker\nWith caption ${config.PREFIX}${command}` }, { quoted: msg })
                  if (!/sticker|webp/.test(quoted.type)) return await socket.sendMessage(sender, { text: `Reply sticker\nWith caption ${config.PREFIX}${command}` }, { quoted: msg })
                  const img = new webp.Image()
                  await img.load(await quoted.download())
                  await socket.sendMessage(sender, { text: util.format(JSON.parse(img.exif.slice(22).toString())) }, { quoted: msg })
                }
                break
                case 'cuaca': case 'weather': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} Karachi` }, { quoted: msg })
                  try {
                    let data = await fetchJson(`https://api.openweathermap.org/data/2.5/weather?q=${text}&units=metric&appid=060a6bcfa19809c2cd4d97a212b19273&language=en`)
                    await socket.sendMessage(sender, { text: `*🏙 City Weather ${data.name}*\n\n*🌤️ Weather :* ${data.weather[0].main}\n*📝 Description :* ${data.weather[0].description}\n*🌡️ Average Temperature :* ${data.main.temp} °C\n*🤔 Feels Like :* ${data.main.feels_like} °C\n*🌬️ Pressure :* ${data.main.pressure} hPa\n*💧 Humidity :* ${data.main.humidity}%\n*🌪️ Wind Velocity :* ${data.wind.speed} Km/h\n*📍Location :*\n- *Longitude :* ${data.coord.lat}\n- *Latitude :* ${data.coord.lon}\n*🌏 Country :* ${data.sys.country}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'City Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'sticker': case 'stiker': case 's': case 'stickergif': case 'stikergif': case 'sgif': case 'stickerwm': case 'swm': case 'curi': case 'colong': case 'take': case 'stickergifwm': case 'sgifwm': {
                  if (!/image|video|sticker/.test(quoted.type)) return await socket.sendMessage(sender, { text: `Send/reply image/video/gif with caption ${config.PREFIX}${command}\nDuration Image/Video/Gif 1-9 Second` }, { quoted: msg })
                  let media = await quoted.download()
                  let teks1 = text.split`|`[0] ? text.split`|`[0] : ''
                  let teks2 = text.split`|`[1] ? text.split`|`[1] : ''
                  if (/image|webp/.test(mime)) {
                    await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                    await socket.sendAsSticker(from, media, msg, { packname: teks1, author: teks2 })
                  } else if (/video/.test(mime)) {
                    if ((quoted).seconds > 11) return await socket.sendMessage(sender, { text: 'Maximum 10 seconds!' }, { quoted: msg })
                    await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                    await socket.sendAsSticker(from, media, msg, { packname: teks1, author: teks2 })
                  } else await socket.sendMessage(sender, { text: `Send/reply image/video/gif with caption ${config.PREFIX}${command}\nDuration Video/Gif 1-9 Second` }, { quoted: msg })
                }
                break
                case 'smeme': case 'stickmeme': case 'stikmeme': case 'stickermeme': case 'stikermeme': {
                  try {
                    if (!/image|webp/.test(mime)) return await socket.sendMessage(sender, { text: `Send/reply image/sticker\nWith caption ${config.PREFIX}${command} atas|bawah` }, { quoted: msg })
                    if (!text) return await socket.sendMessage(sender, { text: `Send/reply image/sticker with caption ${config.PREFIX}${command} atas|bawah` }, { quoted: msg })
                    await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                    let atas = text.split`|`[0] ? text.split`|`[0] : '-'
                    let bawah = text.split`|`[1] ? text.split`|`[1] : '-'
                    let media = await quoted.download()
                    let mem = await UguuSe(media)
                    let smeme = `https://api.memegen.link/images/custom/${encodeURIComponent(atas)}/${encodeURIComponent(bawah)}.png?background=${mem.url}`
                    await socket.sendAsSticker(from, smeme, msg, { packname: 'Light Speed Mini Bot', author: 'Mr Ntando Ofc' })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is Offline!' }, { quoted: msg })
                  }
                }
                break
                case 'emojimix': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} 😅+🤔` }, { quoted: msg })
                  let [emoji1, emoji2] = text.split`+`
                  if (!emoji1 && !emoji2) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} 😅+🤔` }, { quoted: msg })
                  try {
                    let anu = await axios.get(`https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(emoji1)}_${encodeURIComponent(emoji2)}`)
                    if (anu.data.results.length < 1) return await socket.sendMessage(sender, { text: `Mix Emoji ${text} Not Found!` }, { quoted: msg })
                    for (let res of anu.data.results) {
                      await socket.sendAsSticker(from, res.url, msg, { packname: 'Light Speed Mini Bot', author: 'Mr Ntando Ofc' })
                    }
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed Mix Emoji!' }, { quoted: msg })
                  }
                }
                break
                case 'qc': case 'quote': case 'fakechat': {
                  if (!text && !quoted) return await socket.sendMessage(sender, { text: `Send/reply message *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  try {
                    let ppnya = await socket.profilePictureUrl(sender, 'image').catch(() => 'https://i.pinimg.com/564x/8a/e9/e9/8ae9e92fa4e69967aa61bf2bda967b7b.jpg')
                    let res = await quotedLyo(text, pushName, ppnya)
                    await socket.sendAsSticker(from, Buffer.from(res.result.image, 'base64'), msg, { packname: 'Light Speed Mini Bot', author: 'Mr Ntando Ofc' })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is Offline!' }, { quoted: msg })
                  }
                }
                break
                case 'brat': {
                  if (!text && (!quoted || !quoted.text)) return await socket.sendMessage(sender, { text: `Send/reply message *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  try {
                    await socket.sendAsSticker(from, 'https://brat.caliphdev.com/api/brat?text=' + encodeURIComponent(text || quoted.text), msg)
                  } catch (e) {
                    try {
                      await socket.sendAsSticker(from, 'https://aqul-brat.hf.space/?text=' + encodeURIComponent(text || quoted.text), msg)
                    } catch (e) {
                      await socket.sendMessage(sender, { text: 'Server is Offline!' }, { quoted: msg })
                    }
                  }
                }
                break
                case 'bratvid': case 'bratvideo': {
                  if (!text && (!quoted || !quoted.text)) return await socket.sendMessage(sender, { text: `Send/reply message *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  const teks = (quoted ? quoted.text : text).split(' ')
                  const tempDir = path.join(process.cwd(), 'database/sampah')
                  try {
                    const framePaths = []
                    for (let i = 0; i < teks.length; i++) {
                      const currentText = teks.slice(0, i + 1).join(' ')
                      let res
                      try {
                        res = await getBuffer('https://brat.caliphdev.com/api/brat?text=' + encodeURIComponent(currentText))
                      } catch (e) {
                        res = await getBuffer('https://aqul-brat.hf.space/?text=' + encodeURIComponent(currentText))
                      }
                      const framePath = path.join(tempDir, `${sender}${i}.mp4`)
                      fs.writeFileSync(framePath, res)
                      framePaths.push(framePath)
                    }
                    const fileListPath = path.join(tempDir, `${sender}.txt`)
                    let fileListContent = ''
                    for (let i = 0; i < framePaths.length; i++) {
                      fileListContent += `file '${framePaths[i]}'\n`
                      fileListContent += `duration 0.5\n`
                    }
                    fileListContent += `file '${framePaths[framePaths.length - 1]}'\n`
                    fileListContent += `duration 3\n`
                    fs.writeFileSync(fileListPath, fileListContent)
                    const outputVideoPath = path.join(tempDir, `${sender}-output.mp4`)
                    execSync(`ffmpeg -y -f concat -safe 0 -i ${fileListPath} -vf 'fps=30' -c:v libx264 -preset veryfast -pix_fmt yuv420p -t 00:00:10 ${outputVideoPath}`)
                    socket.sendAsSticker(from, outputVideoPath, msg, { packname: 'Light Speed Mini Bot', author: 'Mr Ntando Ofc' })
                    framePaths.forEach((filePath) => fs.unlinkSync(filePath))
                    fs.unlinkSync(fileListPath)
                    fs.unlinkSync(outputVideoPath)
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'An Error Occurred While Processing the Request!' }, { quoted: msg })
                  }
                }
                break
                case 'wasted': {
                  try {
                    if (/jpg|jpeg|png/.test(mime)) {
                      await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                      let media = await quoted.download()
                      let anu = await UguuSe(media)
                      await socket.sendFileUrl(from, 'https://some-random-api.com/canvas/wasted?avatar=' + anu.url, 'Nih Bro', msg)
                    } else await socket.sendMessage(sender, { text: 'Send the media you want to upload!' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is Offline!' }, { quoted: msg })
                  }
                }
                break
                case 'trigger': case 'triggered': {
                  try {
                    if (/jpg|jpeg|png/.test(mime)) {
                      await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                      let media = await quoted.download()
                      let anu = await UguuSe(media)
                      await socket.sendMessage(sender, { document: { url: 'https://some-random-api.com/canvas/triggered?avatar=' + anu.url }, fileName: 'triggered.gif', mimetype: 'image/gif' }, { quoted: msg })
                    } else await socket.sendMessage(sender, { text: 'Send the media you want to upload!' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is Offline!' }, { quoted: msg })
                  }
                }
                break
                case 'nulis': {
                  await socket.sendMessage(sender, { text: `*Example*\n${config.PREFIX}nuliskiri\n${config.PREFIX}nuliskanan\n${config.PREFIX}foliokiri\n${config.PREFIX}foliokanan` }, { quoted: msg })
                }
                break
                case 'nuliskiri': {
                  if (!text) return await socket.sendMessage(sender, { text: `Send Command *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  const splitText = text.replace(/(\S+\s*){1,9}/g, '$&\n')
                  const fixHeight = splitText.split('\n').slice(0, 31).join('\n')
                  spawn('convert', [
                    './src/nulis/images/buku/sebelumkiri.jpg',
                    '-font',
                    './src/nulis/font/Indie-Flower.ttf',
                    '-size',
                    '960x1280',
                    '-pointsize',
                    '23',
                    '-interline-spacing',
                    '2',
                    '-annotate',
                    '+140+153',
                    fixHeight,
                    './src/nulis/images/buku/setelahkiri.jpg'
                  ])
                  .on('error', () => socket.sendMessage(sender, { text: mess.error }, { quoted: msg }))
                  .on('exit', () => {
                    socket.sendMessage(from, { image: fs.readFileSync('./src/nulis/images/buku/setelahkiri.jpg'), caption: 'Do not be lazy Lord. Be a diligent student ರ_ರ' }, { quoted: msg })
                  })
                }
                break
                case 'nuliskanan': {
                  if (!text) return await socket.sendMessage(sender, { text: `Send Command *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  const splitText = text.replace(/(\S+\s*){1,9}/g, '$&\n')
                  const fixHeight = splitText.split('\n').slice(0, 31).join('\n')
                  spawn('convert', [
                    './src/nulis/images/buku/sebelumkanan.jpg',
                    '-font',
                    './src/nulis/font/Indie-Flower.ttf',
                    '-size',
                    '960x1280',
                    '-pointsize',
                    '23',
                    '-interline-spacing',
                    '2',
                    '-annotate',
                    '+128+129',
                    fixHeight,
                    './src/nulis/images/buku/setelahkanan.jpg'
                  ])
                  .on('error', () => socket.sendMessage(sender, { text: mess.error }, { quoted: msg }))
                  .on('exit', () => {
                    socket.sendMessage(from, { image: fs.readFileSync('./src/nulis/images/buku/setelahkanan.jpg'), caption: 'Do not be lazy Lord. Be a diligent student ರ_ರ' }, { quoted: msg })
                  })
                }
                break
                case 'foliokiri': {
                  if (!text) return await socket.sendMessage(sender, { text: `Send Command *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  const splitText = text.replace(/(\S+\s*){1,9}/g, '$&\n')
                  const fixHeight = splitText.split('\n').slice(0, 38).join('\n')
                  spawn('convert', [
                    './src/nulis/images/folio/sebelumkiri.jpg',
                    '-font',
                    './src/nulis/font/Indie-Flower.ttf',
                    '-size',
                    '1720x1280',
                    '-pointsize',
                    '23',
                    '-interline-spacing',
                    '4',
                    '-annotate',
                    '+48+185',
                    fixHeight,
                    './src/nulis/images/folio/setelahkiri.jpg'
                  ])
                  .on('error', () => socket.sendMessage(sender, { text: mess.error }, { quoted: msg }))
                  .on('exit', () => {
                    socket.sendMessage(from, { image: fs.readFileSync('./src/nulis/images/folio/setelahkiri.jpg'), caption: 'Do not be lazy Lord. Be a diligent student ರ_ರ' }, { quoted: msg })
                  })
                }
                break
                case 'foliokanan': {
                  if (!text) return await socket.sendMessage(sender, { text: `Send Command *${config.PREFIX}${command}* Text` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  const splitText = text.replace(/(\S+\s*){1,9}/g, '$&\n')
                  const fixHeight = splitText.split('\n').slice(0, 38).join('\n')
                  spawn('convert', [
                    './src/nulis/images/folio/sebelumkanan.jpg',
                    '-font',
                    './src/nulis/font/Indie-Flower.ttf',
                    '-size',
                    '1720x1280',
                    '-pointsize',
                    '23',
                    '-interline-spacing',
                    '4',
                    '-annotate',
                    '+89+190',
                    fixHeight,
                    './src/nulis/images/folio/setelahkanan.jpg'
                  ])
                  .on('error', () => socket.sendMessage(sender, { text: mess.error }, { quoted: msg }))
                  .on('exit', () => {
                    socket.sendMessage(from, { image: fs.readFileSync('./src/nulis/images/folio/setelahkanan.jpg'), caption: 'Do not be lazy Lord. Be a diligent student ರ_ರ' }, { quoted: msg })
                  })
                }
                break
                case 'bass': case 'blown': case 'deep': case 'earrape': case 'fast': case 'fat': case 'nightcore': case 'reverse': case 'robot': case 'slow': case 'smooth': case 'tupai': {
                  try {
                    let set
                    if (/bass/.test(command)) set = '-af equalizer=f=54:width_type=o:width=2:g=20'
                    if (/blown/.test(command)) set = '-af acrusher=.1:1:64:0:log'
                    if (/deep/.test(command)) set = '-af atempo=4/4,asetrate=44500*2/3'
                    if (/earrape/.test(command)) set = '-af volume=12'
                    if (/fast/.test(command)) set = '-filter:a "atempo=1.63,asetrate=44100"'
                    if (/fat/.test(command)) set = '-filter:a "atempo=1.6,asetrate=22100"'
                    if (/nightcore/.test(command)) set = '-filter:a atempo=1.06,asetrate=44100*1.25'
                    if (/reverse/.test(command)) set = '-filter_complex "areverse"'
                    if (/robot/.test(command)) set = '-filter_complex "afftfilt=real=\'hypot(re,im)*sin(0)\':imag=\'hypot(re,im)*cos(0)\':win_size=512:overlap=0.75"'
                    if (/slow/.test(command)) set = '-filter:a "atempo=0.7,asetrate=44100"'
                    if (/smooth/.test(command)) set = '-filter:v "minterpolate=\'mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps=120\'"'
                    if (/tupai/.test(command)) set = '-filter:a "atempo=0.5,asetrate=65100"'
                    if (/audio/.test(mime)) {
                      await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                      let media = await socket.downloadAndSaveMediaMessage(quoted)
                      let ran = `./database/sampah/${getRandom('.mp3')}`
                      exec(`ffmpeg -i ${media} ${set} ${ran}`, (err, stderr, stdout) => {
                        fs.unlinkSync(media)
                        if (err) return socket.sendMessage(sender, { text: err }, { quoted: msg })
                        let buff = fs.readFileSync(ran)
                        socket.sendMessage(sender, { audio: buff, mimetype: 'audio/mpeg' }, { quoted: msg })
                        fs.unlinkSync(ran)
                      })
                    } else await socket.sendMessage(sender, { text: `Reply to the audio you want to change with a caption *${config.PREFIX}${command}*` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed!' }, { quoted: msg })
                  }
                }
                break
                case 'tinyurl': case 'shorturl': case 'shortlink': {
                  if (!text || !isUrl(text)) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} https://github.com/Light-Dev/Light-Speed-Mini-Bot` }, { quoted: msg })
                  try {
                    let anu = await axios.get('https://tinyurl.com/api-create.php?url=' + text)
                    await socket.sendMessage(sender, { text: 'Url : ' + anu.data }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed!' }, { quoted: msg })
                  }
                }
                break
                case 'git': case 'gitclone': {
                  if (!args[0]) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} https://github.com/Light-Dev/Light-Speed-Mini-Bot` }, { quoted: msg })
                  if (!isUrl(args[0]) && !args[0].includes('github.com')) return await socket.sendMessage(sender, { text: 'Use Github Url!' }, { quoted: msg })
                  let [, user, repo] = args[0].match(/(?:https|git)(?::\/\/|@)github\.com[\/:]([^\/:]+)\/(.+)/i) || []
                  try {
                    await socket.sendMessage(sender, { document: { url: `https://api.github.com/repos/${user}/${repo}/zipball` }, fileName: repo + '.zip', mimetype: 'application/zip' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed!' }, { quoted: msg })
                  }
                }
                break
                case 'define': case 'dictionary': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} Word` }, { quoted: msg })
                  try {
                    const url = `https://gtech-api-xtp1.onrender.com/api/tools/define?apikey=${config.API_KEY}&word=${encodeURIComponent(text)}`
                    let res = await fetch(url)
                    if (!res.ok) throw new Error('Failed to fetch definition')
                    let data = await res.json()
                    if (!data.status || !data.data || !data.data.definition) {
                      return await socket.sendMessage(sender, { text: 'No definition found for that word.' }, { quoted: msg })
                    }
                    let word = data.data.word || text
                    let definition = data.data.definition.trim()
                    let example = data.data.example ? `\n\nExample: ${data.data.example.trim()}` : ''
                    let message = `*Definition of ${word}*\n\n${definition}${example}`
                    await socket.sendMessage(sender, { text: message }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed to fetch the definition.' }, { quoted: msg })
                  }
                }
                break

                // Ai Menu
                case 'ai': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} query` }, { quoted: msg })
                  try {
                    let hasil = await yanzGpt([{ role: 'system', content: '' }, { role: 'user', content: text }])
                    await socket.sendMessage(sender, { text: hasil.choices[0].message.content }, { quoted: msg })
                  } catch (e) {
                    try {
                      let hasil = await youSearch(text)
                      await socket.sendMessage(sender, { text: hasil }, { quoted: msg })
                    } catch (e) {
                      try {
                        let hasil = await bk9Ai(text)
                        await socket.sendMessage(sender, { text: hasil.BK9 }, { quoted: msg })
                      } catch (e) {
                        await socket.sendMessage(sender, { text: pickRandom(['The AI feature is having problems!', 'Unable to connect to AI!', 'AI system is busy now!', 'This feature is currently unavailable!']) }, { quoted: msg })
                      }
                    }
                  }
                }
                break
                case 'simi': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} query` }, { quoted: msg })
                  try {
                    const hasil = await simi(text)
                    await socket.sendMessage(sender, { text: hasil.success }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server is offline!' }, { quoted: msg })
                  }
                }
                break
                case 'bard': case 'gemini': case 'aiedit': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} What date is it now?` }, { quoted: msg })
                  if (!(APIKeys.geminiApikey?.length > 0 && APIKeys.geminiApikey?.some(a => a.trim() !== ''))) return await socket.sendMessage(sender, { text: 'Please get the Apikey first at\nhttps://aistudio.google.com/app/apikey' }, { quoted: msg })
                  try {
                    let apinya = pickRandom(APIKeys.geminiApikey)
                    geminiAi(text, apinya, quoted.isMedia ? { mime: quoted.mime, media: await quoted.download() } : {}).then(a => {
                      if (a.media) socket.sendMedia(from, a.media, '', a.text || '', msg)
                      else if (a.text) socket.sendMessage(sender, { text: a.text }, { quoted: msg })
                    }).catch(e => {
                      if (e.status === 503) socket.sendMessage(sender, { text: 'Gemini model is busy, please try again later...' }, { quoted: msg })
                      else if (e.status === 400) socket.sendMessage(sender, { text: 'API key not valid. Please pass a valid API key.' }, { quoted: msg })
                      else socket.sendMessage(sender, { text: 'Your apikey is limited or another error occurred!' }, { quoted: msg })
                    })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Your apikey is limited!\nPlease Replace with another apikey!' }, { quoted: msg })
                  }
                }
                break

                // Search Menu
                case 'google': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} query` }, { quoted: msg })
                  try {
                    const url = `https://gtech-api-xtp1.onrender.com/api/google/search?query=${encodeURIComponent(text)}&apikey=${config.API_KEY}`
                    let response = await axios.get(url)
                    let data = response.data
                    if (!data.status || !data.results || data.results.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No search results found!' }, { quoted: msg })
                    }
                    let message = data.results.map((item, i) => {
                      let title = item.title || 'No title'
                      return `Result ${i + 1}:\nTitle: ${title}\nLink: ${item.link}\nDescription: ${item.description}\n`
                    }).join('\n')
                    await socket.sendMessage(sender, { text: message }, { quoted: msg })
                  } catch (e) {
                    try {
                      let fallback = await yanzGpt([
                        { role: 'system', content: 'carikan informasi tentang hal tersebut secara mendetail, dengan sumbernya juga!' },
                        { role: 'user', content: text }
                      ])
                      await socket.sendMessage(sender, { text: fallback.choices[0].message.content }, { quoted: msg })
                    } catch (e2) {
                      await socket.sendMessage(sender, { text: 'Search Not Found!' }, { quoted: msg })
                    }
                  }
                }
                break
                case 'bing': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} query` }, { quoted: msg })
                  try {
                    const url = `https://gtech-api-xtp1.onrender.com/api/bing/search?query=${encodeURIComponent(text)}&apikey=${config.API_KEY}`
                    let response = await axios.get(url)
                    let data = response.data
                    if (!data.status || !data.results || !data.results.results || data.results.results.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No search results found!' }, { quoted: msg })
                    }
                    let message = data.results.results.map((item, i) => {
                      let title = item.title || 'No title'
                      let url = item.url || 'No URL'
                      let desc = item.description || 'No description'
                      return `Result ${i + 1}:\nTitle: ${title}\nLink: ${url}\nDescription: ${desc}\n`
                    }).join('\n')
                    await socket.sendMessage(sender, { text: message }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Search Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'wiki': case 'wikipedia': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} Albert Einstein` }, { quoted: msg })
                  try {
                    let response = await Qasim.wikisearch(text)
                    if (!response || !Array.isArray(response) || response.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No Wikipedia results found!' }, { quoted: msg })
                    }
                    let data = response[0]
                    let summary = data.wiki.replace(/\n+/g, '\n').replace(/<[^>]*>/g, '').trim()
                    let title = data.judul || text
                    let pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
                    let message = `*${title}*\n\n${summary}\n\nRead more: ${pageUrl}`
                    await socket.sendMessage(from, {
                      image: { url: data.thumb || 'https://pngimg.com/uploads/wikipedia/wikipedia_PNG35.png' },
                      caption: message
                    }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed to fetch Wikipedia results!' }, { quoted: msg })
                  }
                }
                break
                case 'technews': {
                  try {
                    let url = `https://gtech-api-xtp1.onrender.com/api/tech/news?apikey=${config.API_KEY}`
                    let response = await fetch(url)
                    let data = await response.json()
                    if (!data.status || !data.message || !data.thumbnailUrl) {
                      return await socket.sendMessage(sender, { text: 'No news found!' }, { quoted: msg })
                    }
                    let message = data.message
                    let newsMatch = message.match(/News:\s*([\s\S]*)/)
                    if (!newsMatch || !newsMatch[1]) {
                      return await socket.sendMessage(sender, { text: 'No news found!' }, { quoted: msg })
                    }
                    let newsText = newsMatch[1].trim()
                    newsText = newsText.replace(/\.embed-container[\s\S]*/g, '').trim()
                    await socket.sendMessage(from, {
                      image: { url: data.thumbnailUrl },
                      caption: `"${newsText}"`
                    }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'News Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'wattpad': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} story name` }, { quoted: msg })
                  try {
                    let response = await Qasim.wattpad(text)
                    if (!Array.isArray(response) || response.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No Wattpad stories found!' }, { quoted: msg })
                    }
                    let firstThumb = response[0].thumb
                    let caption = response.map(story => {
                      return `Title: ${story.judul}\nReads: ${story.dibaca}\nVotes: ${story.divote}\nLink: ${story.link}`
                    }).join('\n\n')
                    await socket.sendMessage(from, {
                      image: { url: firstThumb },
                      caption: `"${caption}"`
                    }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed to fetch Wattpad stories!' }, { quoted: msg })
                  }
                }
                break
                case 'gimage': case 'bingimg': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} query` }, { quoted: msg })
                  try {
                    let response = await Qasim.googleImage(text)
                    let images = response.imageUrls
                    if (!images || !Array.isArray(images) || images.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No images found!' }, { quoted: msg })
                    }
                    let imagesToSend = images.slice(0, 4)
                    for (let imgUrl of imagesToSend) {
                      await socket.sendMessage(from, { image: { url: imgUrl }, caption: 'Search Results: ' + text }, { quoted: msg })
                    }
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Search Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'trendtwit': case 'trends': case 'xtrends': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} Pakistan` }, { quoted: msg })
                  try {
                    let response = await Qasim.trendtwit(text)
                    if (!response || !response.country || !Array.isArray(response.result) || response.result.length === 0) {
                      return await socket.sendMessage(sender, { text: 'No trending data found for this country!' }, { quoted: msg })
                    }
                    let trends = response.result
                    let topTrends = trends.slice(0, 10).map(trend => {
                      return `${trend.rank}. ${trend.hastag}\nTweets: ${trend.tweet}`
                    }).join('\n\n')
                    let message = `📊 *Top Twitter Trends in ${response.country}*\n\n${topTrends}`
                    await socket.sendMessage(sender, { text: message }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed to fetch Twitter trends!' }, { quoted: msg })
                  }
                }
                break
                case 'play': case 'ytplay': case 'yts': case 'ytsearch': case 'youtubesearch': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} dj komang` }, { quoted: msg })
                  await socket.sendMessage(sender, { text: '⏳ Searching...' }, { quoted: msg })
                  try {
                    const res = await yts.search(text)
                    const hasil = pickRandom(res.all)
                    const teksnya = `*📍Title:* ${hasil.title || 'Not available'}\n*✏Description:* ${hasil.description || 'Not available'}\n*🌟Channel:* ${hasil.author?.name || 'Not available'}\n*⏳Duration:* ${hasil.seconds || 'Not available'} second (${hasil.timestamp || 'Not available'})\n*🔎Source:* ${hasil.url || 'Not available'}\n\n_note : if you want to download please_\n_choose ${config.PREFIX}ytmp3 url_video or ${config.PREFIX}ytmp4 url_video_`
                    await socket.sendMessage(from, { image: { url: hasil.thumbnail }, caption: teksnya }, { quoted: msg })
                  } catch (e) {
                    try {
                      const nvl = new NvlGroup()
                      let anu = await nvl.search(text)
                      let hasil = pickRandom(anu.videos)
                      let teksnya = `*📍Title:* ${hasil.title || 'Not available'}\n*✏Upload At:* ${hasil.uploaded || 'Not available'}\n*🌟Channel:* ${hasil.author || 'Not available'}\n*⏳Duration:* ${hasil.duration || 'Not available'}\n*🔎Source:* ${hasil.url || 'Not available'}\n\n_note : If you want to download please_\n_choose ${config.PREFIX}ytmp3 url_video or ${config.PREFIX}ytmp4 url_video_`
                      await socket.sendMessage(from, { image: { url: hasil.thumbnail }, caption: teksnya }, { quoted: msg })
                    } catch (e) {
                      try {
                        const res = await fetchApi('/search/youtube', { query: text })
                        const hasil = pickRandom(res.data)
                        const teksnya = `*📍Title:* ${hasil.title || 'Not available'}\n*✏Description:* ${hasil.description || 'Not available'}\n*🌟Channel:* ${hasil.channelTitle || 'Not available'}\n*⏳Duration:* ${hasil.duration || 'Not available'}\n*🔎Source:* https://youtu.be/${hasil.id || 'Not available'}\n\n_note : If you want to download please_\n_choose ${config.PREFIX}ytmp3 url_video or ${config.PREFIX}ytmp4 url_video_`
                        await socket.sendMessage(from, { image: { url: hasil.thumbMedium }, caption: teksnya }, { quoted: msg })
                      } catch (e) {
                        await socket.sendMessage(sender, { text: 'Post not available!' }, { quoted: msg })
                      }
                    }
                  }
                }
                break
                case 'pixiv': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} hu tao` }, { quoted: msg })
                  try {
                    let { pixivdl } = require('./lib/pixiv')
                    let res = await pixivdl(text)
                    await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                    for (let i = 0; i < res.media.length; i++) {
                      let caption = i == 0 ? `${res.caption}\n\n*By:* ${res.artist}\n*Tags:* ${res.tags.join(', ')}` : ''
                      let mime = (await FileType.fromBuffer(res.media[i])).mime
                      await socket.sendMessage(from, { [mime.split('/')[0]]: res.media[i], caption, mimetype: mime }, { quoted: msg })
                    }
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Post not available!' }, { quoted: msg })
                  }
                }
                break
                case 'pinterest': case 'pint': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} hu tao` }, { quoted: msg })
                  try {
                    let anu = await pinterest(text)
                    let result = pickRandom(anu)
                    if (anu.length < 1) {
                      await socket.sendMessage(sender, { text: 'Post not available!' }, { quoted: msg })
                    } else {
                      await socket.sendMessage(from, { image: { url: result.images_url }, caption: `*Media Url :* ${result.pin}${result.link ? '\n*Source :* ' + result.link : ''}` }, { quoted: msg })
                    }
                  } catch (e) {
                    try {
                      const res = await fetchApi('/search/pinterest', { query: text })
                      const hasil = pickRandom(res.data.result.pins)
                      await socket.sendMessage(from, { image: { url: hasil.media.images.orig.url }, caption: `*Media Url :* ${hasil.media.images.orig.url}${hasil.pin_url ? '\n*Source :* ' + hasil.pin_url : ''}` }, { quoted: msg })
                    } catch (e) {
                      await socket.sendMessage(sender, { text: 'Search not found!' }, { quoted: msg })
                    }
                  }
                }
                break
                case 'wallpaper': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} hu tao` }, { quoted: msg })
                  try {
                    let anu = await wallpaper(text)
                    let result = pickRandom(anu)
                    if (anu.length < 1) {
                      await socket.sendMessage(sender, { text: 'Post not available!' }, { quoted: msg })
                    } else {
                      await socket.sendMessage(from, { image: { url: result.image[0] }, caption: `⭔ title : ${text}\n⭔ category : ${result.type}\n⭔ media url : ${result.image[2] || result.image[1] || result.image[0]}` }, { quoted: msg })
                    }
                  } catch (e) {
                    try {
                      let anu = await pinterest('wallpaper ' + text)
                      let result = pickRandom(anu)
                      if (anu.length < 1) {
                        await socket.sendMessage(sender, { text: 'Post not available!' }, { quoted: msg })
                      } else {
                        await socket.sendMessage(from, { image: { url: result.images_url }, caption: `*Media Url :* ${result.pin}${result.link ? '\n*Source :* ' + result.link : ''}` }, { quoted: msg })
                      }
                    } catch (e) {
                      await socket.sendMessage(sender, { text: 'Server is offline!' }, { quoted: msg })
                    }
                  }
                }
                break
                case 'ringtone': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} black rover` }, { quoted: msg })
                  try {
                    let anu = await ringtone(text)
                    let result = pickRandom(anu)
                    await socket.sendMessage(from, { audio: { url: result.audio }, fileName: result.title + '.mp3', mimetype: 'audio/mpeg' }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Audio not found!' }, { quoted: msg })
                  }
                }
                break
                case 'npm': case 'npmjs': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} axios` }, { quoted: msg })
                  try {
                    let res = await fetch(`http://registry.npmjs.com/-/v1/search?text=${text}`)
                    let { objects } = await res.json()
                    if (!objects.length) return await socket.sendMessage(sender, { text: 'Search Not found' }, { quoted: msg })
                    let txt = objects.map(({ package: pkg }) => {
                      return `*${pkg.name}* (v${pkg.version})\n_${pkg.links.npm}_\n_${pkg.description}_`
                    }).join`\n\n`
                    await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Search Not found' }, { quoted: msg })
                  }
                }
                break
                case 'style': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} Qasim` }, { quoted: msg })
                  let anu = await styletext(text)
                  let txt = anu.map(a => `*${a.name}*\n${a.result}`).join`\n\n`
                  await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                }
                break
                case 'spotify': case 'spotifysearch': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} alan walker alone` }, { quoted: msg })
                  try {
                    let hasil = await fetchJson('https://www.bhandarimilan.info.np/spotisearch?query=' + encodeURIComponent(text))
                    let txt = hasil.map(a => {
                      return `*Name : ${a.name}*\n- Artist : ${a.artist}\n- Url : ${a.link}`
                    }).join`\n\n`
                    await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Server Search Offline!' }, { quoted: msg })
                  }
                }
                break
                case 'tenor': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} alone` }, { quoted: msg })
                  try {
                    const anu = await fetchJson('https://g.tenor.com/v1/search?q=' + text + '&key=LIVDSRZULELA')
                    const hasil = pickRandom(anu.results)
                    await socket.sendMessage(from, { video: { url: hasil.media[0].mp4.url }, caption: `👀 *Media:* ${hasil.url}\n📋 *Description:* ${hasil.content_description}\n🔛 *Url:* ${hasil.itemurl}`, gifPlayback: true, gifAttribution: 2 }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'No Results Found!' }, { quoted: msg })
                  }
                }
                break
                case 'urban': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} alone` }, { quoted: msg })
                  try {
                    const anu = await fetchJson('https://api.urbandictionary.com/v0/define?term=' + text)
                    const hasil = pickRandom(anu.list)
                    await socket.sendMessage(sender, { text: `${hasil.definition}\n\nSource: ${hasil.permalink}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'No Results Found!' }, { quoted: msg })
                  }
                }
                break

                // Stalker Menu
                case 'igstalk': case 'instagramstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} username` }, { quoted: msg })
                  try {
                    let anu = await instaStalk(text)
                    await socket.sendMessage(from, { image: { url: anu.avatar }, caption: `*Username :* ${anu.username}\n*Nickname :* ${anu.nickname}\n*Bio :* ${anu.description}\n*Posts :* ${anu.posts}\n*Followers :* ${anu.followers}\n*Following :* ${anu.following}\n*List Post :* ${anu.list_post.map(a => `\n*Url :* ${a.imageUrl}\n*Description :* ${a.description}\n*Detail :* ${a.detailUrl}`).join('\n')}` }, { quoted: msg })
                  } catch (e) {
                    try {
                      let res = await fetchApi('/stalk/instagram', { username: text })
                      await socket.sendMessage(from, { image: { url: res.data.profile_picture_url }, caption: `*Username :*${res.data?.username || 'unavailable'}\n*Nickname :*${res.data?.full_name || 'unavailable'}\n*ID :*${res.data?.instagram_id}\n*Followers :*${res.data?.followers || '0'}\n*Following :*${res.data?.following || '0'}\n*Description :*${res.data?.description || 'unavailable'}\n*Website :*${res.data?.website || 'unavailable'}\n*Add At :*${res.data?.added_date}\n*Uploads :*${res.data?.uploads}\n*Verified :*${res.data?.is_verified}\n*Private :*${res.data.is_private}\n` }, { quoted: msg })
                    } catch (e) {
                      await socket.sendMessage(sender, { text: 'Username Not Found!' }, { quoted: msg })
                    }
                  }
                }
                break
                case 'wastalk': case 'whatsappstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} @tag / 923xxx` }, { quoted: msg })
                  try {
                    let num = quoted?.sender || mentionedJid?.[0] || text
                    if (!num) return await socket.sendMessage(sender, { text: `Example : ${config.PREFIX}${command} @tag / 923xxx` }, { quoted: msg })
                    num = num.replace(/\D/g, '') + '@s.whatsapp.net'
                    if (!(await socket.onWhatsApp(num))[0]?.exists) return await socket.sendMessage(sender, { text: 'Number not registered on WhatsApp!' }, { quoted: msg })
                    let img = await socket.profilePictureUrl(num, 'image').catch(_ => 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png?q=60')
                    let bio = await socket.fetchStatus(num).catch(_ => { })
                    let name = await socket.getName(num)
                    let business = await socket.getBusinessProfile(num)
                    let format = PhoneNum(`+${num.split('@')[0]}`)
                    let regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
                    let country = regionNames.of(format.getRegionCode('international'))
                    let wea = `WhatsApp Stalk\n\n*° Country :* ${country.toUpperCase()}\n*° Name :* ${name ? name : '-'}\n*° Format Number :* ${format.getNumber('international')}\n*° Url Api :* wa.me/${num.split('@')[0]}\n*° Mentions :* @${num.split('@')[0]}\n*° Status :* ${bio?.status || '-'}\n*° Date Status :* ${bio?.setAt ? moment(bio.setAt.toDateString()).locale('id').format('LL') : '-'}\n\n${business ? `*WhatsApp Business Stalk*\n\n*° BusinessId :* ${business.wid}\n*° Website :* ${business.website ? business.website : '-'}\n*° Email :* ${business.email ? business.email : '-'}\n*° Category :* ${business.category}\n*° Address :* ${business.address ? business.address : '-'}\n*° Timeone :* ${business.business_hours.timezone ? business.business_hours.timezone : '-'}\n*° Description* : ${business.description ? business.description : '-'}` : '*Standard WhatsApp Account*'}`
                    img ? await socket.sendMessage(from, { image: { url: img }, caption: wea, mentions: [num] }, { quoted: msg }) : await socket.sendMessage(sender, { text: wea }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Number Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'telestalk': case 'telegramstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} username` }, { quoted: msg })
                  try {
                    const res = await telegramStalk(text)
                    if (!res.description || res.title.startsWith('Telegram: Contact')) throw 'Error'
                    await socket.sendMessage(from, { image: { url: res.image_url }, caption: `*Username :* ${text}\n*Nickname :* ${res.title || 'unavailable'}\n*Desc :* ${res.description || 'unavailable'}\n*Url :* ${res.url}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'User Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'tiktokstalk': case 'ttstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} username` }, { quoted: msg })
                  try {
                    const res = await tiktokStalk(text)
                    await socket.sendMessage(from, { image: { url: res.avatarThumb }, caption: `*Username :* ${text}\n*Nickname :* ${res.nickname}\n*Followers :* ${res.followerCount}\n*Following :* ${res.followingCount}\n*Bio :* ${res.signature}\n*Verified :* ${res.verified}\n*Video Count :* ${res.videoCount}\n*Heart Count :* ${res.heartCount}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Username Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'genshinstalk': case 'gistalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} id` }, { quoted: msg })
                  try {
                    const res = await genshinStalk(text)
                    await socket.sendMessage(from, { image: { url: res.image }, caption: `*Genshin profile*\n- *ID :* ${res.uid}\n- *Nickname :* ${res.nickname}\n- *Signature :* ${res.signature}\n- *Level :* ${res.level}\n- *World Level :* ${res.world_level}\n- *Achivement :* ${res.achivement}\n- *Spiral Abyss :* ${res.spiral_abyss}\n- *Ttl :* ${res.ttl}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Username Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'ghstalk': case 'githubstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} username` }, { quoted: msg })
                  try {
                    const res = await fetchJson('https://api.github.com/users/' + text)
                    await socket.sendMessage(from, { image: { url: res.avatar_url }, caption: `*Username :* ${res.login}\n*Nickname :* ${res.name || 'unavailabe'}\n*Bio :* ${res.bio || 'unavailable'}\n*ID :* ${res.id}\n*Node ID :* ${res.node_id}\n*Type :* ${res.type}\n*Admin :* ${res.admin ? 'Yes' : 'No'}\n*Company :* ${res.company || 'unavailable'}\n*Blog :* ${res.blog || 'unavailable'}\n*Location :* ${res.location || 'unavailable'}\n*Email :* ${res.email || 'unavailble'}\n*Public Repo :* ${res.public_repos}\n*Public Gists :* ${res.public_gists}\n*Followers :* ${res.followers}\n*Following :* ${res.following}\n*Created At :* ${res.created_at} *Updated At :* ${res.updated_at}` }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Username Not Found!' }, { quoted: msg })
                  }
                }
                break
                case 'npmstalk': {
                  if (!text) return await socket.sendMessage(sender, { text: `Example: ${config.PREFIX}${command} express` }, { quoted: msg })
                  try {
                    let response = await Qasim.npmStalk(text)
                    if (!response.status || !response.result || !response.result.name) {
                      return await socket.sendMessage(sender, { text: 'No npm package found!' }, { quoted: msg })
                    }
                    let pkg = response.result
                    let name = pkg.name || text
                    let version = (pkg['dist-tags'] && pkg['dist-tags'].latest) || 'N/A'
                    let description = pkg.description || 'No description available.'
                    let author = (pkg.author && pkg.author.name) || 'Unknown'
                    let license = pkg.license || 'Unknown'
                    let homepage = pkg.homepage || `https://www.npmjs.com/package/${name}`
                    let repository = (pkg.repository && pkg.repository.url) || 'N/A'
                    let message = `*${name}*\n\nVersion: ${version}\nAuthor: ${author}\nLicense: ${license}\nDescription: ${description}\n\nHomepage: ${homepage}\nRepository: ${repository}`
                    await socket.sendMessage(sender, { text: message }, { quoted: msg })
                  } catch (e) {
                    await socket.sendMessage(sender, { text: 'Failed to fetch npm package info!' }, { quoted: msg })
                  }
                }
                break
              default: {
                // Unknown command - do nothing
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage('❌ ERROR', 'An error occurred while processing your command. Please try again.', 'M O O N  𝗫 𝗠 𝗗')
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: sanitizedNumber });
        return session ? session.creds : null;
    } catch (error) {
        console.error('MongoDB restore error:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const session = await Session.findOne({ number });
        return session && session.config ? session.config : { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        await Session.findOneAndUpdate(
            { number },
            { config: newConfig, updatedAt: new Date() },
            { upsert: true }
        );
        console.log(`✅ Config updated for ${number}`);
    } catch (error) {
        console.error('❌ Config update error:', error);
        throw error;
    }
}

async function deleteSessionFromStorage(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    try {
        await Session.deleteOne({ number: sanitizedNumber });
        console.log(`✅ Session deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('❌ MongoDB delete error:', error);
    }
    
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`User ${number} logged out. Deleting session...`);
                
                await deleteSessionFromStorage(number);
                
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage('🗑️ SESSION DELETED', '✅ Your session has been deleted due to logout.', 'M O O N  𝗫 𝗠 𝗗')
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}`, error);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const sessionData = JSON.parse(fileContent);
            
            try {
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { 
                        creds: sessionData,
                        lastActive: new Date(),
                        updatedAt: new Date()
                    },
                    { upsert: true }
                );
                console.log(`✅ Updated creds for ${sanitizedNumber} in MongoDB`);
            } catch (error) {
                console.error('❌ MongoDB save error:', error);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message || err);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message || error);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                           '𝐖𝙴𝙻𝙲𝐎𝐌𝐄 𝐓𝐎  M O O N 𝗫 𝗠 𝗗  MINI',
                           `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n\n📢 Follow Channel: ${config.CHANNEL_LINK}`,
                           '> M O O N  𝗫 𝗠 𝗗'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (res && !res.headersSent) {
            try {
                res.status(503).send({ error: 'Service Unavailable' });
            } catch {}
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'M O O N  𝗫 𝗠 𝗗 is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const sessions = await Session.find({});
        
        if (sessions.length === 0) {
            return res.status(404).send({ error: 'No session files found in MongoDB' });
        }

        const results = [];
        for (const session of sessions) {
            if (activeSockets.has(session.number)) {
                results.push({ number: session.number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(session.number, mockRes);
                results.push({ number: session.number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${session.number}:`, error);
                results.push({ number: session.number, status: 'failed', error: error.message || error });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', 'M O O N  X 𝗠 𝗗 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃')
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    try { fs.emptyDirSync(SESSION_BASE_PATH); } catch {}
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || config.PM2_NAME}`);
});

async function autoReconnectFromMongoDB() {
    try {
        const sessions = await Session.find({});
        
        for (const session of sessions) {
            if (!activeSockets.has(session.number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(session.number, mockRes);
                console.log(`🔁 Reconnected from MongoDB: ${session.number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ MongoDB auto-reconnect error:', error);
    }
}

autoReconnectFromMongoDB();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/mrfr8nk/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message || err);
        return [];
    }
}
