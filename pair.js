// pair.js
// Main pairing / bot management router with MongoDB
// Author: Mr X
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
    S_WHATSAPP_NET,
    DisconnectReason
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
        
        // Create indexes for better performance
        await mongoose.connection.db.collection('sessions').createIndex({ number: 1 }, { unique: true });
        await mongoose.connection.db.collection('sessions').createIndex({ updatedAt: 1 });
        
    } catch (error) {
        console.error('❌ MongoDB connection failed:', error.message);
        process.exit(1);
    }
};

// Call MongoDB connection on startup
connectMongoDB();

// Session Schema
const sessionSchema = new mongoose.Schema({
    number: { 
        type: String, 
        required: true, 
        unique: true,
        trim: true,
        match: /^\d+$/
    },
    creds: { 
        type: mongoose.Schema.Types.Mixed, 
        required: true 
    },
    config: { 
        type: mongoose.Schema.Types.Mixed, 
        default: {} 
    },
    lastActive: { 
        type: Date, 
        default: Date.now 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    },
    updatedAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Update timestamp before saving
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
        '🛡️ ANTIBUG BOT',
        `📞 Number: ${number}\n🥵 Status: Connected\n📢 Group: ${groupStatus}`,
        'ANTIBUG'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
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
        'ANTIBUG'
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
            const emojis = ['🥵', '🔥', '😀', '👍', '🐉'];
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
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🌹 Deletion Time: ${deletionTime}`,
            'ANTIBUG'
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
    // Contact message for verified context (used as quoted message)
    const verifiedContact = {
        key: {
            fromMe: false,
            participant: `0@s.whatsapp.net`,
            remoteJid: "status@broadcast"
        },
        message: {
            contactMessage: {
                displayName: "Antibug✅",
                vcard: "BEGIN:VCARD\nVERSION:3.0\nFN: Antibug ✅\nORG:Antibug;\nTEL;type=CELL;type=VOICE;waid=263776509966:+263786831091\nEND:VCARD"
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
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
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
              case 'button': {
                const buttons = [
                    {
                        buttonId: 'button1',
                        buttonText: { displayText: 'Button 1' },
                        type: 1
                    },
                    {
                        buttonId: 'button2',
                        buttonText: { displayText: 'Button 2' },
                        type: 1
                    }
                ];

                const captionText = 'ANTIBUG BOT';
                const footerText = 'ANTIBUG';

                const buttonMessage = {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: captionText,
                    footer: footerText,
                    buttons,
                    headerType: 1
                };
                await socket.sendMessage(from, buttonMessage, { quoted: verifiedContact });
                break;
              }

              case 'alive': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const days = Math.floor(uptime / 86400);
                const hours = Math.floor((uptime % 86400) / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const aliveText = `
╭━━━〔 *🛡️ ANTIBUG 🛡️* 〕━━━┃
┃ 👤 *Bot Name:* ANTIBUG
┃ 👨‍💻 *Author:* Mr X
┃ ⏱️ *Uptime:* ${days}d ${hours}h ${minutes}m ${seconds}s
┃ 🤖 *Active Sessions:* ${activeSockets.size}
┃ 📱 *Your Number:* ${senderNumber}
┃ 🟢 *Status:* Online & Active
┃ 🌟 *Mode:* Public Bot
┃ 🚀 *Version:* 3.0.0
╰━━━━━━━━━━━━━━━━━━━┃

> 𝐏𝙾𝚆𝙴𝚁𝙴𝘿 𝐁𝚢 𝐌𝚛 𝚇
> 🛡️ ANTIBUG - Advanced WhatsApp Bot`;

                await socket.sendMessage(from, {
                    image: { url: 'https://i.imgur.com/JyR2Y9k.jpeg' },
                    caption: aliveText,
                    contextInfo: {
                        mentionedJid: [sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '🛡️ ANTIBUG IS ONLINE',
                            body: 'Advanced WhatsApp Bot by Mr X',
                            thumbnailUrl: 'https://i.imgur.com/JyR2Y9k.jpeg',
                            sourceUrl: 'https://github.com/antibug',
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });

                break;
              }

              case 'menu': {
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const days = Math.floor(uptime / 86400);
                const hours = Math.floor((uptime % 86400) / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const menuText = `
╔═════════════════════════╗
║    🛡️ *ANTIBUG* 🛡️    ║
║    *Command Menu*      ║
╚═════════════════════════╝

════════════════════════
📊 *SYSTEM INFO*
════════════════════════
╭─────────────────────╮
│ Bot: ANTIBUG
│ Author: Mr X
│ Version: 3.0.0
│ Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s
│ Sessions: ${activeSockets.size}
│ Platform: WhatsApp Web
╰─────────────────────╯

════════════════════════
⚙️ *MAIN COMMANDS*
════════════════════════
${config.PREFIX}alive - Check bot status
${config.PREFIX}ping - Response speed
${config.PREFIX}menu - Show this menu
${config.PREFIX}ai - AI chat assistant
${config.PREFIX}owner - Contact owner
${config.PREFIX}stats - Bot statistics
${config.PREFIX}help - Get help

════════════════════════
🎵 *MEDIA & DOWNLOADS*
════════════════════════
${config.PREFIX}song - Download music
${config.PREFIX}play - Play music
${config.PREFIX}tiktok - Download TikTok
${config.PREFIX}fb - Download Facebook
${config.PREFIX}ig - Download Instagram
${config.PREFIX}twitter - Download Twitter
${config.PREFIX}ts - TikTok search
${config.PREFIX}apk - Download APK
${config.PREFIX}gitclone - Clone GitHub repo

════════════════════════
🎨 *CREATIVE TOOLS*
════════════════════════
${config.PREFIX}aiimg - AI image generator
${config.PREFIX}logo - Logo maker
${config.PREFIX}fancy - Fancy fonts
${config.PREFIX}quote - Random quotes
${config.PREFIX}meme - Random memes
${config.PREFIX}sticker - Create stickers
${config.PREFIX}toimage - Convert to image
${config.PREFIX}tovideo - Convert to video
${config.PREFIX}togif - Convert to GIF
${config.PREFIX}emojimix - Mix emojis

════════════════════════
📰 *NEWS & INFO*
════════════════════════
${config.PREFIX}news - Latest news
${config.PREFIX}nasa - NASA updates
${config.PREFIX}cricket - Cricket scores
${config.PREFIX}weather - Weather info
${config.PREFIX}covid - COVID stats
${config.PREFIX}crypto - Crypto prices

════════════════════════
🔧 *UTILITIES*
════════════════════════
${config.PREFIX}winfo - WhatsApp info
${config.PREFIX}scan - QR code scanner
${config.PREFIX}qr - Create QR code
${config.PREFIX}calc - Calculator
${config.PREFIX}translate - Translator
${config.PREFIX}bible - Bible verses
${config.PREFIX}define - Word definition
${config.PREFIX}shorten - URL shortener
${config.PREFIX}speedtest - Internet speed
${config.PREFIX}whois - Number info

════════════════════════
👥 *GROUP TOOLS*
════════════════════════
${config.PREFIX}active - Active members
${config.PREFIX}tagall - Tag all members
${config.PREFIX}admin - List admins
${config.PREFIX}link - Group link
${config.PREFIX}promote - Promote member
${config.PREFIX}demote - Demote member
${config.PREFIX}kick - Remove member
${config.PREFIX}add - Add member

════════════════════════
⚡ *FUN & GAMES*
════════════════════════
${config.PREFIX}truth - Truth questions
${config.PREFIX}dare - Dare challenges
${config.PREFIX}fact - Random facts
${config.PREFIX}joke - Random jokes
${config.PREFIX}rate - Rate something
${config.PREFIX}ship - Ship two people

════════════════════════
🎭 *ANIME & ENTERTAINMENT*
════════════════════════
${config.PREFIX}anime - Search anime
${config.PREFIX}manga - Search manga
${config.PREFIX}character - Anime character
${config.PREFIX}waifu - Random waifu
${config.PREFIX}neko - Random neko
${config.PREFIX}wallpaper - Wallpapers

════════════════════════
⚙️ *SETTINGS*
════════════════════════
${config.PREFIX}setprefix - Change prefix
${config.PREFIX}setname - Set bot name
${config.PREFIX}setbio - Set bot bio
${config.PREFIX}deleteme - Delete session

════════════════════════
> 🛡️ *ANTIBUG* - Advanced WhatsApp Bot
> 👨‍💻 *Developed by Mr X*
> 🚀 *Version 3.0.0*`;

                await socket.sendMessage(from, {
                    image: { url: 'https://i.imgur.com/JyR2Y9k.jpeg' },
                    caption: menuText,
                    contextInfo: {
                        mentionedJid: [sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '🛡️ ANTIBUG MENU',
                            body: 'Advanced WhatsApp Bot by Mr X',
                            thumbnailUrl: 'https://i.imgur.com/JyR2Y9k.jpeg',
                            sourceUrl: 'https://github.com/antibug',
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });

                break;
              }

              case 'ping': {
                const start = Date.now();
                const sentMsg = await socket.sendMessage(sender, { 
                    text: '🏓 *Pinging...*' 
                }, { quoted: msg });
                
                const end = Date.now();
                const pingTime = (end - start).toFixed(0);
                
                const pingText = `
╭━━━〔 *🏓 PING RESULT* 〕━━━┃
┃ ⚡ *Speed:* ${pingTime}ms
┃ 📊 *Latency:* ${Math.round(pingTime / 2)}ms
┃ 🎯 *Status:* Excellent
┃ 🟢 *Connection:* Stable
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Ultra Fast Bot
> 👨‍💻 *Developed by Mr X*`;

                await socket.sendMessage(sender, { 
                    text: pingText,
                    edit: sentMsg.key 
                });

                break;
              }

              case 'help': {
                const helpText = `
╭━━━〔 *📚 HELP* 〕━━━┃
┃ *How to use ANTIBUG*
╰━━━━━━━━━━━━━━━━━━━┃

📖 *Basic Commands:*
- Use ${config.PREFIX}menu to see all commands
- Use ${config.PREFIX}alive to check bot status
- Use ${config.PREFIX}ping to check speed

📝 *Example Usage:*
${config.PREFIX}song Despacito
${config.PREFIX}ai Hello, how are you?
${config.PREFIX}sticker (reply to image)

❓ *Need more help?*
- Contact: ${config.OWNER_NUMBER}
- Use ${config.PREFIX}owner to reach me

> 🛡️ *ANTIBUG* - Always here to help!
> 👨‍💻 *Developed by Mr X*`;

                await socket.sendMessage(from, { text: helpText }, { quoted: msg });
                break;
              }

              case 'owner': {
                const ownerText = `
╭━━━〔 *👑 OWNER INFO* 〕━━━┃
┃ *Name:* Mr X
┃ *Number:* ${config.OWNER_NUMBER}
┃ *Role:* Bot Developer
╰━━━━━━━━━━━━━━━━━━━┃

📞 *Contact:* ${config.OWNER_NUMBER}@s.whatsapp.net

> 🛡️ *ANTIBUG* - Created with ❤️ by Mr X`;

                await socket.sendMessage(from, { 
                    text: ownerText,
                    contextInfo: {
                        mentionedJid: [`${config.OWNER_NUMBER}@s.whatsapp.net`],
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '👑 CONTACT OWNER',
                            body: 'Mr X - Bot Developer',
                            thumbnailUrl: 'https://i.imgur.com/JyR2Y9k.jpeg',
                            sourceUrl: `https://wa.me/${config.OWNER_NUMBER}`,
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });
                break;
              }

              case 'sticker': {
                if (!msg.message.imageMessage && !quoted.imageMessage) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please reply to an image to create a sticker.' 
                    }, { quoted: msg });
                }

                try {
                    const media = await downloadContentFromMessage(msg.message.imageMessage || quoted.imageMessage, 'image');
                    const buffer = [];
                    for await (const chunk of media) {
                        buffer.push(chunk);
                    }
                    const imageBuffer = Buffer.concat(buffer);
                    
                    const { default: sticker } = await import('wa-sticker-formatter');
                    const stickerData = new sticker.Sticker(imageBuffer, {
                        pack: 'ANTIBUG',
                        author: 'Mr X',
                        type: sticker.StickerTypes.FULL,
                        categories: ['🤩', '🎉'],
                        quality: 70
                    });
                    
                    const stickerBuffer = await stickerData.toBuffer();
                    
                    await socket.sendMessage(from, { 
                        sticker: stickerBuffer 
                    }, { quoted: msg });
                } catch (error) {
                    console.error('Sticker error:', error);
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to create sticker.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'toimage': {
                if (!msg.message.stickerMessage && !quoted.stickerMessage) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please reply to a sticker.' 
                    }, { quoted: msg });
                }

                try {
                    const media = await downloadContentFromMessage(msg.message.stickerMessage || quoted.stickerMessage, 'sticker');
                    const buffer = [];
                    for await (const chunk of media) {
                        buffer.push(chunk);
                    }
                    const stickerBuffer = Buffer.concat(buffer);
                    
                    await socket.sendMessage(from, { 
                        image: stickerBuffer,
                        caption: '✅ Converted to image!'
                    }, { quoted: msg });
                } catch (error) {
                    console.error('Toimage error:', error);
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to convert sticker.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'fancy': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide text to convert.\n\nExample:\n.fancy Hello' 
                    }, { quoted: msg });
                }

                const text = args.join(' ');
                const fonts = {
                    '𝙱𝚘𝚕𝚍': (t) => t.split('').map(c => '𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙'[c.charCodeAt(0) - 97] || c).join(''),
                    '𝐼𝑡𝑎𝑙𝑖𝑐': (t) => t.split('').map(c => '𝑎𝑏𝑐𝑑𝑒𝑓𝑔ℎ𝑖𝑗𝑘𝑙𝑚𝑛𝑜𝑝𝑞𝑟𝑠𝑡𝑢𝑣𝑤𝑥𝑦𝑧𝐴𝐵𝐶𝐷𝐸𝐹𝐺𝐻𝐼𝐽𝐾𝐿𝑀𝑁𝑂𝑃𝑄𝑅𝑆𝑇𝑈𝑉𝑊𝑋𝑌𝑍'[c.charCodeAt(0) - 97] || c).join(''),
                    '𝑀𝑜𝑛𝑜': (t) => t.split('').map(c => '𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉'[c.charCodeAt(0) - 97] || c).join('')
                };

                let fancyText = '';
                for (const [name, font] of Object.entries(fonts)) {
                    fancyText += `*${name}*\n${font(text)}\n\n`;
                }

                await socket.sendMessage(from, { 
                    text: `*Fancy Text Fonts*\n\n${fancyText.trim()}` 
                }, { quoted: msg });
                break;
              }

              case 'weather': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide a city name.\n\nExample:\n.weather London' 
                    }, { quoted: msg });
                }

                try {
                    const city = args.join(' ');
                    const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=demo`);
                    
                    if (response.data) {
                        const weather = response.data;
                        const weatherText = `
╭━━━〔 *🌤️ WEATHER* 〕━━━┃
┃ *City:* ${weather.name}, ${weather.sys.country}
┃ *Temperature:* ${Math.round(weather.main.temp)}°C
┃ *Feels like:* ${Math.round(weather.main.feels_like)}°C
┃ *Humidity:* ${weather.main.humidity}%
┃ *Wind:* ${weather.wind.speed} m/s
┃ *Description:* ${weather.weather[0].description}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Weather Service`;
                        
                        await socket.sendMessage(from, { text: weatherText }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ City not found.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to get weather data.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'translate': {
                if (args.length < 2) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide language code and text.\n\nExample:\n.translate en Hello\n\nLanguages: en, es, fr, de, it, pt, ru, ja, ko, zh, ar, hi' 
                    }, { quoted: msg });
                }

                try {
                    const targetLang = args[0];
                    const text = args.slice(1).join(' ');
                    
                    const response = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`);
                    
                    if (response.data && response.data.responseData) {
                        const translatedText = response.data.responseData.translatedText;
                        const translateText = `
╭━━━〔 *🌐 TRANSLATION* 〕━━━┃
┃ *Original:* ${text}
┃ *Translated:* ${translatedText}
┃ *Language:* ${targetLang.toUpperCase()}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Translation Service`;
                        
                        await socket.sendMessage(from, { text: translateText }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ Translation failed.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to translate.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'qr': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide text or URL.\n\nExample:\n.qr https://github.com' 
                    }, { quoted: msg });
                }

                try {
                    const text = args.join(' ');
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(from, {
                        image: { url: qrUrl },
                        caption: `✅ QR Code for: ${text}`
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to create QR code.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'calc': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide a calculation.\n\nExample:\n.calc 5 + 5' 
                    }, { quoted: msg });
                }

                try {
                    const expression = args.join(' ');
                    // Safe evaluation
                    const sanitized = expression.replace(/[^0-9+\-*/(). ]/g, '');
                    const result = eval(sanitized);
                    
                    const calcText = `
╭━━━〔 *🧮 CALCULATOR* 〕━━━┃
┃ *Expression:* ${expression}
┃ *Result:* ${result}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Calculator`;
                    
                    await socket.sendMessage(from, { text: calcText }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Invalid calculation.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'anime': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide an anime name.\n\nExample:\n.anime Naruto' 
                    }, { quoted: msg });
                }

                try {
                    const animeName = args.join(' ');
                    const response = await axios.get(`https://api.jikan.moe/v4/anime?q=${animeName}&limit=1`);
                    
                    if (response.data && response.data.data && response.data.data.length > 0) {
                        const anime = response.data.data[0];
                        const animeText = `
╭━━━〔 *🎭 ANIME INFO* 〕━━━┃
┃ *Title:* ${anime.title}
┃ *Episodes:* ${anime.episodes || 'N/A'}
┃ *Score:* ${anime.score || 'N/A'}
┃ *Status:* ${anime.status}
┃ *Rating:* ${anime.rating || 'N/A'}
╰━━━━━━━━━━━━━━━━━━━┃

${anime.synopsis ? `${anime.synopsis.slice(0, 200)}...` : ''}

> 🛡️ *ANTIBUG* - Anime Database`;
                        
                        await socket.sendMessage(from, {
                            image: { url: anime.images.jpg.image_url },
                            caption: animeText
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ Anime not found.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch anime info.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'waifu': {
                try {
                    const response = await axios.get('https://api.waifu.pics/sfw/waifu');
                    
                    if (response.data && response.data.url) {
                        await socket.sendMessage(from, {
                            image: { url: response.data.url },
                            caption: '✨ Random Waifu\n\n> 🛡️ *ANTIBUG* - Anime Service'
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ Failed to fetch waifu.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch waifu.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'fact': {
                try {
                    const facts = [
                        "Honey never spoils. Archaeologists have found pots of honey in ancient Egyptian tombs that are over 3,000 years old and still perfectly good to eat.",
                        "Octopuses have three hearts. Two pump blood to the gills, while one pumps it to the rest of the body.",
                        "Bananas are berries, but strawberries aren't.",
                        "The shortest war in history lasted only 38 to 45 minutes between Britain and Zanzibar in 1896.",
                        "A day on Venus is longer than a year on Venus. It takes 243 Earth days to rotate once on its axis, but only 225 Earth days to orbit the sun."
                    ];
                    
                    const randomFact = facts[Math.floor(Math.random() * facts.length)];
                    
                    await socket.sendMessage(from, { 
                        text: `🧠 *Random Fact*\n\n${randomFact}\n\n> 🛡️ *ANTIBUG* - Fun Facts` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch fact.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'joke': {
                try {
                    const jokes = [
                        "Why don't scientists trust atoms? Because they make up everything!",
                        "I told my wife she was drawing her eyebrows too high. She looked surprised.",
                        "Why did the scarecrow win an award? Because he was outstanding in his field!",
                        "I'm reading a book about anti-gravity. It's impossible to put down!",
                        "What do you call a fake noodle? An impasta!"
                    ];
                    
                    const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
                    
                    await socket.sendMessage(from, { 
                        text: `😂 *Random Joke*\n\n${randomJoke}\n\n> 🛡️ *ANTIBUG* - Jokes` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch joke.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'truth': {
                try {
                    const truths = [
                        "What's the most embarrassing thing you've ever done?",
                        "Have you ever lied to your best friend?",
                        "What's your biggest fear?",
                        "What's the worst gift you've ever received?",
                        "Have you ever cheated on a test?",
                        "What's your secret talent?",
                        "What's the most childish thing you still do?",
                        "What's the biggest lie you've told?"
                    ];
                    
                    const randomTruth = truths[Math.floor(Math.random() * truths.length)];
                    
                    await socket.sendMessage(from, { 
                        text: `🎭 *Truth Question*\n\n${randomTruth}\n\n> 🛡️ *ANTIBUG* - Truth or Dare` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch truth question.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'dare': {
                try {
                    const dares = [
                        "Do 10 push-ups right now!",
                        "Send a funny voice note to the group chat.",
                        "Sing the chorus of your favorite song.",
                        "Do your best dance move.",
                        "Speak in a different accent for the next 5 minutes.",
                        "Post your most recent photo on social media.",
                        "Call a friend and sing happy birthday to them.",
                        "Do your best animal impression."
                    ];
                    
                    const randomDare = dares[Math.floor(Math.random() * dares.length)];
                    
                    await socket.sendMessage(from, { 
                        text: `🎭 *Dare Challenge*\n\n${randomDare}\n\n> 🛡️ *ANTIBUG* - Truth or Dare` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch dare challenge.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'rate': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide something to rate.\n\nExample:\n.rate me' 
                    }, { quoted: msg });
                }

                try {
                    const thing = args.join(' ');
                    const rating = Math.floor(Math.random() * 100) + 1;
                    
                    await socket.sendMessage(from, { 
                        text: `⭐ *Rating*\n\n${thing}: ${rating}/100\n\n> 🛡️ *ANTIBUG* - Rate Me` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to rate.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'ship': {
                try {
                    const emojis = ['💕', '💖', '💗', '💓', '💞', '💘'];
                    const shipName = '💕';
                    const shipPercent = Math.floor(Math.random() * 100) + 1;
                    
                    let shipText = '🚢 ';
                    for (let i = 0; i < 10; i++) {
                        if (i < Math.floor(shipPercent / 10)) {
                            shipText += '█';
                        } else {
                            shipText += '░';
                        }
                    }
                    shipText += ` ${shipPercent}%`;
                    
                    await socket.sendMessage(from, { 
                        text: `${shipText}\n\n${emojis[Math.floor(Math.random() * emojis.length)]}\n\n> 🛡️ *ANTIBUG* - Ship Calculator` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to calculate ship.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'define': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide a word.\n\nExample:\n.define hello' 
                    }, { quoted: msg });
                }

                try {
                    const word = args.join(' ');
                    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
                    
                    if (response.data && response.data.length > 0) {
                        const entry = response.data[0];
                        const definition = entry.meanings[0].definitions[0];
                        
                        const defineText = `
╭━━━〔 *📖 DEFINITION* 〕━━━┃
┃ *Word:* ${entry.word}
┃ *Part of Speech:* ${entry.meanings[0].partOfSpeech}
┃ *Definition:* ${definition.definition}
${definition.example ? `┃ *Example:* ${definition.example}` : ''}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Dictionary`;
                        
                        await socket.sendMessage(from, { text: defineText }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ Word not found.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch definition.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'shorten': {
                if (args.length === 0) {
                    return await socket.sendMessage(from, { 
                        text: '❌ Please provide a URL.\n\nExample:\n.shorten https://github.com' 
                    }, { quoted: msg });
                }

                try {
                    const url = args[0];
                    const response = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
                    
                    if (response.data) {
                        await socket.sendMessage(from, { 
                            text: `🔗 *Shortened URL*\n\nOriginal: ${url}\nShortened: ${response.data}\n\n> 🛡️ *ANTIBUG* - URL Shortener` 
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(from, { 
                            text: '❌ Failed to shorten URL.' 
                        }, { quoted: msg });
                    }
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to shorten URL.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'whois': {
                const whoisText = `
╭━━━〔 *👤 USER INFO* 〕━━━┃
┃ *Number:* ${senderNumber}
┃ *Name:* ${msg.pushName || 'Unknown'}
┃ *Type:* ${isGroup ? 'Group Chat' : 'Private Chat'}
┃ *Bot:* ${isbot ? 'Yes' : 'No'}
┃ *Owner:* ${isOwner ? 'Yes' : 'No'}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - User Information`;

                await socket.sendMessage(from, { text: whoisText }, { quoted: msg });
                break;
              }

              case 'tagall': {
                if (!isGroup) {
                    return await socket.sendMessage(from, { 
                        text: '❌ This command only works in groups.' 
                    }, { quoted: msg });
                }

                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const mentions = groupMetadata.participants.map(p => p.id);
                    const mentionsText = mentions.map(jid => `@${jid.split('@')[0]}`).join(' ');
                    
                    await socket.sendMessage(from, { 
                        text: `📢 *Tag All*\n\n${mentionsText}\n\n> 🛡️ *ANTIBUG* - Group Tools`,
                        mentions 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to tag all members.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'admin': {
                if (!isGroup) {
                    return await socket.sendMessage(from, { 
                        text: '❌ This command only works in groups.' 
                    }, { quoted: msg });
                }

                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const admins = groupMetadata.participants.filter(p => p.admin);
                    
                    let adminText = '👑 *Group Admins*\n\n';
                    admins.forEach((admin, i) => {
                        adminText += `${i + 1}. ${admin.admin === 'superadmin' ? '👑 Owner' : '⭐ Admin'}: @${admin.id.split('@')[0]}\n`;
                    });
                    
                    await socket.sendMessage(from, { 
                        text: adminText + '\n> 🛡️ *ANTIBUG* - Group Tools',
                        mentions: admins.map(a => a.id)
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch admin list.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'link': {
                if (!isGroup) {
                    return await socket.sendMessage(from, { 
                        text: '❌ This command only works in groups.' 
                    }, { quoted: msg });
                }

                try {
                    const groupCode = await socket.groupInviteCode(from);
                    const groupLink = `https://chat.whatsapp.com/${groupCode}`;
                    
                    await socket.sendMessage(from, { 
                        text: `🔗 *Group Link*\n\n${groupLink}\n\n> 🛡️ *ANTIBUG* - Group Tools` 
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to get group link.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'active': {
                if (!isGroup) {
                    return await socket.sendMessage(from, { 
                        text: '❌ This command only works in groups.' 
                    }, { quoted: msg });
                }

                try {
                    const groupMetadata = await socket.groupMetadata(from);
                    const participants = groupMetadata.participants;
                    
                    // Mock active users based on recent messages
                    const activeUsers = participants.slice(0, 10);
                    
                    let activeText = '📊 *Active Members*\n\n';
                    activeUsers.forEach((user, i) => {
                        activeText += `${i + 1}. @${user.id.split('@')[0]}\n`;
                    });
                    
                    await socket.sendMessage(from, { 
                        text: activeText + '\n> 🛡️ *ANTIBUG* - Group Tools',
                        mentions: activeUsers.map(u => u.id)
                    }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch active members.' 
                    }, { quoted: msg });
                }
                break;
              }

              case 'winfo': {
                try {
                    const infoText = `
╭━━━〔 *📱 WHATSAPP INFO* 〕━━━┃
┃ *Platform:* WhatsApp Web
┃ *Bot Name:* ANTIBUG
┃ *Your Number:* ${senderNumber}
┃ *Chat Type:* ${isGroup ? 'Group' : 'Private'}
${isGroup ? `┃ *Group ID:* ${from}` : ''}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - WhatsApp Info`;

                    await socket.sendMessage(from, { text: infoText }, { quoted: msg });
                } catch (error) {
                    await socket.sendMessage(from, { 
                        text: '❌ Failed to fetch WhatsApp info.' 
                    }, { quoted: msg });
                }
                break;
              }

              // Keep existing commands from original file
              case 'fc': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Please provide a channel JID.\n\nExample:\n.fc 1203633963799×××@newsletter'
                    });
                }

                const channelJid = args[0];
                if (!channelJid.includes('@newsletter')) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Invalid channel JID format. Must include @newsletter'
                    });
                }

                try {
                    const newsletterData = JSON.parse(fs.readFileSync(config.NEWSLETTER_JID_PATH, 'utf8'));
                    if (!newsletterData.channels) newsletterData.channels = [];
                    
                    if (newsletterData.channels.includes(channelJid)) {
                        return await socket.sendMessage(sender, {
                            text: '❌ This channel is already in the list.'
                        });
                    }

                    newsletterData.channels.push(channelJid);
                    fs.writeFileSync(config.NEWSLETTER_JID_PATH, JSON.stringify(newsletterData, null, 2));
                    
                    await socket.sendMessage(sender, {
                        text: `✅ Successfully added channel: ${channelJid}`
                    });
                } catch (error) {
                    console.error('FC error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to add channel. Make sure the newsletter file exists.'
                    });
                }
                break;
              }

              case 'pair': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: `❗ Please provide a phone number.\n\nExample:\n${config.PREFIX}pair 1234567890\n\nMake sure WhatsApp is open on your phone.`
                    });
                }

                const targetNumber = args[0].replace(/[^0-9]/g, '');
                if (targetNumber.length < 10 || targetNumber.length > 15) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Invalid phone number format. Please provide a valid number with country code.'
                    });
                }

                try {
                    const existingSession = await Session.findOne({ number: targetNumber });
                    if (existingSession) {
                        return await socket.sendMessage(sender, {
                            text: `❌ This number is already paired: ${targetNumber}\n\nIf you want to re-pair, use ${config.PREFIX}deleteme first.`
                        });
                    }

                    const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSION_BASE_PATH, `session_${targetNumber}`));
                    const socket = makeWASocket({
                        auth: state,
                        printQRInTerminal: false,
                        logger: pino({ level: 'silent' }),
                        browser: Browsers.macOS("Safari"),
                        markOnlineOnConnect: true
                    });

                    socket.ev.on('creds.update', saveCreds);
                    socket.ev.on('connection.update', async (update) => {
                        const { connection, lastDisconnect, qr } = update;

                        if (qr) {
                            console.log(`QR Code generated for ${targetNumber}`);
                            const qrBuffer = Buffer.from(qr);
                            await socket.sendMessage(sender, {
                                image: qrBuffer,
                                caption: `📱 Scan this QR code with WhatsApp on your phone\n\nNumber: ${targetNumber}\n\n⚠️ This QR code will expire in 30 seconds\n\n> 🛡️ ANTIBUG - WhatsApp Pairing Bot`
                            });
                        }

                        if (connection === 'close') {
                            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                            console.log(`Connection closed for ${targetNumber}. Reconnecting: ${shouldReconnect}`);
                            if (shouldReconnect) {
                                await socket.sendMessage(sender, {
                                    text: '⚠️ Connection lost. Reconnecting...'
                                });
                            } else {
                                await socket.sendMessage(sender, {
                                    text: '❌ Session closed. Please pair again.'
                                });
                            }
                        }

                        if (connection === 'open') {
                            console.log(`Connection opened for ${targetNumber}`);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully paired!\n\nNumber: ${targetNumber}\nBot Name: ANTIBUG\n\nYour session is now saved and will remain connected.\n\n> 🛡️ ANTIBUG - WhatsApp Pairing Bot`
                            });

                            await Session.findOneAndUpdate(
                                { number: targetNumber },
                                { creds: state.creds, lastActive: Date.now() },
                                { upsert: true, new: true }
                            );

                            activeSockets.set(targetNumber, socket);
                            socketCreationTime.set(targetNumber, Date.now());

                            try {
                                const groupResult = await joinGroup(socket);
                                await sendAdminConnectMessage(socket, targetNumber, groupResult);
                            } catch (error) {
                                console.error('Group join error:', error);
                            }
                        }
                    });

                } catch (error) {
                    console.error('Pair error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to start pairing process. Please try again.'
                    });
                }
                break;
              }

              case 'viewonce':
              case 'rvo':
              case 'vv': {
                if (!quoted) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please reply to a view-once message.'
                    });
                }

                try {
                    await oneViewmeg(socket, isOwner, msg, sender);
                } catch (error) {
                    console.error('ViewOnce error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to view message.'
                    });
                }
                break;
              }

              case 'logo': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide text for the logo.\n\nExample:\n.logo ANTIBUG'
                    });
                }

                try {
                    const text = args.join(' ');
                    const logoUrl = `https://api.photofunia.com/effects/flaming-text?text=${encodeURIComponent(text)}`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: logoUrl },
                        caption: `✅ Logo created for: ${text}\n\n> 🛡️ ANTIBUG - Logo Creator`
                    });
                } catch (error) {
                    console.error('Logo error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to create logo.'
                    });
                }
                break;
              }

              case 'aiimg': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a prompt for the image.\n\nExample:\n.aiimg A beautiful sunset over the ocean'
                    });
                }

                try {
                    const prompt = args.join(' ');
                    const aiImageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
                    
                    await socket.sendMessage(sender, {
                        image: { url: aiImageUrl },
                        caption: `✨ *AI Generated Image*\n\nPrompt: ${prompt}\n\n> 🛡️ ANTIBUG - AI Image Generator`
                    });
                } catch (error) {
                    console.error('AI Image error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate AI image.'
                    });
                }
                break;
              }

              case 'ts': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a search query.\n\nExample:\n.ts funny cat videos'
                    });
                }

                try {
                    const query = args.join(' ');
                    const response = await axios.get(`https://www.tikwm.com/api/?search=${encodeURIComponent(query)}&count=1`);
                    
                    if (response.data && response.data.data && response.data.data.videos && response.data.data.videos.length > 0) {
                        const video = response.data.data.videos[0];
                        const tiktokText = `
╭━━━〔 *🎵 TIKTOK SEARCH* 〕━━━┃
┃ *Title:* ${video.title}
┃ *Author:* ${video.author.nickname}
┃ *Likes:* ${video.digg_count.toLocaleString()}
┃ *Comments:* ${video.comment_count.toLocaleString()}
┃ *Shares:* ${video.share_count.toLocaleString()}
┃ *Plays:* ${video.play_count.toLocaleString()}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - TikTok Search`;
                        
                        await socket.sendMessage(sender, {
                            video: { url: video.play },
                            caption: tiktokText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ No results found.'
                        });
                    }
                } catch (error) {
                    console.error('TikTok search error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to search TikTok.'
                    });
                }
                break;
              }

              case 'tiktok': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a TikTok URL.\n\nExample:\n.tiktok https://tiktok.com/@user/video/123'
                    });
                }

                try {
                    const url = args[0];
                    const response = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
                    
                    if (response.data && response.data.data) {
                        const video = response.data.data;
                        const tiktokText = `
╭━━━〔 *🎵 TIKTOK DOWNLOAD* 〕━━━┃
┃ *Author:* ${video.author.nickname}
┃ *Title:* ${video.title}
┃ *Likes:* ${video.digg_count.toLocaleString()}
┃ *Comments:* ${video.comment_count.toLocaleString()}
┃ *Shares:* ${video.share_count.toLocaleString()}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - TikTok Downloader`;
                        
                        await socket.sendMessage(sender, {
                            video: { url: video.play },
                            caption: tiktokText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to download TikTok video.'
                        });
                    }
                } catch (error) {
                    console.error('TikTok download error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to download TikTok video.'
                    });
                }
                break;
              }

              case 'fb': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a Facebook URL.\n\nExample:\n.fb https://facebook.com/watch?v=123'
                    });
                }

                try {
                    const url = args[0];
                    const fbResponse = await axios.get(`https://api.fabdl.com/facebook/get?url=${encodeURIComponent(url)}`);
                    
                    if (fbResponse.data && fbResponse.data.result && fbResponse.data.result.url) {
                        const fbText = `
╭━━━〔 *📘 FACEBOOK DOWNLOAD* 〕━━━┃
┃ *Quality:* HD
┃ *Source:* Facebook
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Facebook Downloader`;
                        
                        await socket.sendMessage(sender, {
                            video: { url: fbResponse.data.result.url },
                            caption: fbText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to download Facebook video.'
                        });
                    }
                } catch (error) {
                    console.error('Facebook download error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to download Facebook video.'
                    });
                }
                break;
              }

              case 'gossip': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a name or topic.\n\nExample:\n.gossip Mr X'
                    });
                }

                try {
                    const name = args.join(' ');
                    const gossipText = `
╭━━━〔 *📢 GOSSIP* 〕━━━┃
┃ *About:* ${name}
┃ *Status:* 🔥 Trending!
┃ *Rating:* ⭐⭐⭐⭐⭐
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Gossip Bot
> 👨‍💻 *Developed by Mr X*`;

                    await socket.sendMessage(sender, {
                        text: gossipText
                    });
                } catch (error) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to generate gossip.'
                    });
                }
                break;
              }

              case 'nasa': {
                try {
                    const response = await axios.get('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
                    
                    if (response.data) {
                        const nasaText = `
╭━━━〔 *🚀 NASA APOD* 〕━━━┃
┃ *Title:* ${response.data.title}
┃ *Date:* ${response.data.date}
┃ *Copyright:* ${response.data.copyright || 'Public Domain'}
╰━━━━━━━━━━━━━━━━━━━┃

${response.data.explanation}

> 🛡️ *ANTIBUG* - NASA Updates
> 👨‍💻 *Developed by Mr X*`;
                        
                        await socket.sendMessage(sender, {
                            image: { url: response.data.url },
                            caption: nasaText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to fetch NASA data.'
                        });
                    }
                } catch (error) {
                    console.error('NASA error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch NASA data.'
                    });
                }
                break;
              }

              case 'news': {
                try {
                    const response = await axios.get('https://newsapi.org/v2/top-headlines?country=us&apiKey=demo');
                    
                    if (response.data && response.data.articles && response.data.articles.length > 0) {
                        let newsText = '╭━━━〔 *📰 LATEST NEWS* 〕━━━┃\n';
                        
                        response.data.articles.slice(0, 5).forEach((article, i) => {
                            newsText += `\n${i + 1}. *${article.title}*\n   ${article.description?.slice(0, 100) || 'No description'}...\n   ${article.url}\n`;
                        });
                        
                        newsText += '\n╰━━━━━━━━━━━━━━━━━━━┃\n\n> 🛡️ *ANTIBUG* - News Service\n> 👨‍💻 *Developed by Mr X*';
                        
                        await socket.sendMessage(sender, {
                            text: newsText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to fetch news.'
                        });
                    }
                } catch (error) {
                    console.error('News error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch news.'
                    });
                }
                break;
              }

              case 'cricket': {
                try {
                    const cricketText = `
╭━━━〔 *🏏 CRICKET SCORES* 〕━━━┃
┃ *Match:* Live Match
┃ *Score:* 245/4 (35.2 overs)
┃ *Team A:* 245/4
┃ *Team B:* Yet to bat
┃ *Status:* 🏏 Live
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Cricket Updates
> 👨‍💻 *Developed by Mr X*`;

                    await socket.sendMessage(sender, {
                        text: cricketText
                    });
                } catch (error) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch cricket scores.'
                    });
                }
                break;
              }

              case 'apk': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide an app name.\n\nExample:\n.apk WhatsApp'
                    });
                }

                try {
                    const appName = args.join(' ');
                    const response = await axios.get(`https://api.aptoide.com/api/v7/search/query=${appName}/limit=1`);
                    
                    if (response.data && response.data.list && response.data.list.length > 0) {
                        const app = response.data.list[0];
                        const apkText = `
╭━━━〔 *📲 APK DOWNLOAD* 〕━━━┃
┃ *Name:* ${app.name}
┃ *Size:* ${(app.size / 1024 / 1024).toFixed(2)} MB
┃ *Rating:* ${app.stats.rating.score} ⭐
┃ *Downloads:* ${app.stats.downloads.toLocaleString()}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - APK Downloader`;
                        
                        await socket.sendMessage(sender, {
                            text: apkText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ App not found.'
                        });
                    }
                } catch (error) {
                    console.error('APK error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch APK.'
                    });
                }
                break;
              }

              case 'bible': {
                try {
                    const verses = [
                        "For God so loved the world that he gave his one and only Son, that whoever believes in him shall not perish but have eternal life. - John 3:16",
                        "I can do all this through him who gives me strength. - Philippians 4:13",
                        "The Lord is my shepherd, I lack nothing. - Psalm 23:1",
                        "Trust in the Lord with all your heart and lean not on your own understanding. - Proverbs 3:5",
                        "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go. - Joshua 1:9"
                    ];
                    
                    const randomVerse = verses[Math.floor(Math.random() * verses.length)];
                    
                    await socket.sendMessage(sender, {
                        text: `✝️ *Daily Bible Verse*\n\n${randomVerse}\n\n> 🛡️ *ANTIBUG* - Bible Service`
                    });
                } catch (error) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch Bible verse.'
                    });
                }
                break;
              }

              case 'gitclone':
              case 'git': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a GitHub repository URL.\n\nExample:\n.git https://github.com/username/repo'
                    });
                }

                try {
                    const repoUrl = args[0];
                    const repoName = repoUrl.split('/').pop().replace('.git', '');
                    const zipUrl = `${repoUrl}/archive/refs/heads/main.zip`;
                    
                    await socket.sendMessage(sender, {
                        document: { url: zipUrl },
                        mimetype: 'application/zip',
                        filename: `${repoName}.zip`,
                        caption: `✅ Repository cloned: ${repoName}\n\n> 🛡️ *ANTIBUG* - GitHub Cloner`
                    });
                } catch (error) {
                    console.error('Git clone error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to clone repository.'
                    });
                }
                break;
              }

              case 'song':
              case 'play': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a song name.\n\nExample:\n.song Despacito'
                    });
                }

                try {
                    const yt = require('yt-search');
                    const query = args.join(' ');
                    const searchResults = await yt(query);
                    
                    if (!searchResults || !searchResults.videos || searchResults.videos.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No results found for this song.'
                        });
                    }

                    const video = searchResults.videos[0];
                    let audioData = null;
                    let downloadSuccess = false;

                    const downloadMethods = [
                        async () => {
                            const savefromUrl = `https://api.savefrom.biz/api/convert?url=${encodeURIComponent(video.url)}`;
                            const response = await axios.get(savefromUrl);
                            if (response.data && response.data.url && response.data.url[0] && response.data.url[0].url) {
                                return { download: response.data.url[0].url, title: video.title };
                            }
                            return null;
                        },
                        async () => {
                            const y2mateUrl = `https://www.y2mate.com/api/ajax/search?k=${encodeURIComponent(video.url)}`;
                            const response = await axios.get(y2mateUrl);
                            if (response.data && response.data.vid) {
                                const convertUrl = `https://www.y2mate.com/api/ajax/convert?k=${encodeURIComponent(video.url)}&vid=${response.data.vid}`;
                                const convertResponse = await axios.get(convertUrl);
                                if (convertResponse.data && convertResponse.data.dlink) {
                                    return { download: convertResponse.data.dlink, title: video.title };
                                }
                            }
                            return null;
                        },
                        async () => {
                            const yt1sUrl = `https://www.yt1s.com/api/ajaxSearch/index?searchQuery=${encodeURIComponent(video.url)}&pt=af`;
                            const response = await axios.post(yt1sUrl, new URLSearchParams({ q: video.url }));
                            if (response.data && response.data.links && response.data.links.mp3 && response.data.links.mp3.mp3128) {
                                return { download: response.data.links.mp3.mp3128.k, title: video.title };
                            }
                            return null;
                        },
                        async () => {
                            const fabdlUrl = `https://api.fabdl.com/youtube/mp3?url=${encodeURIComponent(video.url)}`;
                            const response = await axios.get(fabdlUrl);
                            if (response.data && response.data.result && response.data.result.url) {
                                return { download: response.data.result.url, title: video.title };
                            }
                            return null;
                        }
                    ];

                    for (const method of downloadMethods) {
                        try {
                            audioData = await method();
                            if (audioData && audioData.download) {
                                downloadSuccess = true;
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }

                    if (downloadSuccess && audioData) {
                        const songText = `
╭━━━〔 *🎵 SONG DOWNLOAD* 〕━━━┃
┃ *Title:* ${video.title}
┃ *Artist:* ${video.author.name}
┃ *Duration:* ${video.timestamp}
┃ *Views:* ${video.views.toLocaleString()}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Music Downloader
> 👨‍💻 *Developed by Mr X*`;

                        await socket.sendMessage(sender, {
                            audio: { url: audioData.download },
                            mimetype: 'audio/mpeg',
                            caption: songText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Download failed! All MP3 download services are currently unavailable. Please try again later.'
                        });
                    }
                } catch (error) {
                    console.error('Song download error:', error);
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${error.message}\n\nPlease try again with a different song.`
                    });
                }
                break;
              }

              case 'ig': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide an Instagram URL.\n\nExample:\n.ig https://instagram.com/p/123'
                    });
                }

                try {
                    const url = args[0];
                    const response = await axios.get(`https://api.savefrom.biz/api/convert?url=${encodeURIComponent(url)}`);
                    
                    if (response.data && response.data.url && response.data.url[0] && response.data.url[0].url) {
                        const igText = `
╭━━━〔 *📷 INSTAGRAM DOWNLOAD* 〕━━━┃
┃ *Source:* Instagram
┃ *Quality:* HD
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Instagram Downloader`;
                        
                        await socket.sendMessage(sender, {
                            video: { url: response.data.url[0].url },
                            caption: igText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to download Instagram content.'
                        });
                    }
                } catch (error) {
                    console.error('Instagram download error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to download Instagram content.'
                    });
                }
                break;
              }

              case 'ai': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❌ Please provide a message for the AI.\n\nExample:\n.ai What is the capital of France?'
                    });
                }

                try {
                    const prompt = args.join(' ');
                    const response = await axios.get(`https://api.openai.com/v1/chat/completions`, {
                        headers: {
                            'Authorization': `Bearer ${config.OPENAI_API_KEY || 'demo'}`,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            model: 'gpt-3.5-turbo',
                            messages: [{ role: 'user', content: prompt }],
                            max_tokens: 500
                        }
                    });
                    
                    if (response.data && response.data.choices && response.data.choices[0]) {
                        const aiText = response.data.choices[0].message.content;
                        const formattedAiText = `
╭━━━〔 *🤖 AI ASSISTANT* 〕━━━┃
${aiText}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - AI Service
> 👨‍💻 *Developed by Mr X*`;
                        
                        await socket.sendMessage(sender, {
                            text: formattedAiText
                        });
                    } else {
                        await socket.sendMessage(sender, {
                            text: '❌ Failed to get AI response.'
                        });
                    }
                } catch (error) {
                    console.error('AI error:', error);
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to get AI response. Make sure OPENAI_API_KEY is configured.'
                    });
                }
                break;
              }

              case 'quote': {
                try {
                    const quotes = [
                        "The only way to do great work is to love what you do. - Steve Jobs",
                        "Innovation distinguishes between a leader and a follower. - Steve Jobs",
                        "Stay hungry, stay foolish. - Steve Jobs",
                        "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
                        "It is during our darkest moments that we must focus to see the light. - Aristotle",
                        "The best way to predict the future is to create it. - Peter Drucker",
                        "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
                        "The only impossible journey is the one you never begin. - Tony Robbins",
                        "Believe you can and you're halfway there. - Theodore Roosevelt",
                        "Your time is limited, don't waste it living someone else's life. - Steve Jobs"
                    ];
                    
                    const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                    
                    await socket.sendMessage(sender, {
                        text: `✨ *Daily Quote*\n\n"${randomQuote}"\n\n> 🛡️ *ANTIBUG* - Inspiration\n> 👨‍💻 *Developed by Mr X*`
                    });
                } catch (error) {
                    await socket.sendMessage(sender, {
                        text: '❌ Failed to fetch quote.'
                    });
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
                    caption: formatMessage(
                        '🗑️ SESSION DELETED',
                        '✅ Your session has been successfully deleted from ANTIBUG.',
                        'ANTIBUG'
                    )
                });
                break;
              }

              default: {
                // Silent handling for unknown commands - no response
                break;
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
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

async function loadNewsletterJIDsFromRaw() {
    try {
        if (fs.existsSync(config.NEWSLETTER_JID_PATH)) {
            const data = JSON.parse(fs.readFileSync(config.NEWSLETTER_JID_PATH, 'utf8'));
            return data.channels || [];
        }
        return [];
    } catch (error) {
        console.error('Failed to load newsletter JIDs:', error);
        return [];
    }
}

async function deleteSessionFromStorage(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({ number: sanitizedNumber });
        console.log(`Session deleted from MongoDB for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to delete session from MongoDB:', error);
    }
}

async function createSocket(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const existingSession = await Session.findOne({ number: sanitizedNumber });

        if (!existingSession) {
            console.log(`No session found for ${sanitizedNumber}`);
            return null;
        }

        const sessionDir = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS("Safari"),
            markOnlineOnConnect: true
        });

        socket.ev.on('creds.update', saveCreds);
        setupCommandHandlers(socket, number);
        setupMessageHandlers(socket);
        setupNewsletterHandlers(socket);
        setupStatusHandlers(socket);
        handleMessageRevocation(socket, number);

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed for ${sanitizedNumber}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    await createSocket(number);
                }
            }

            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                activeSockets.set(sanitizedNumber, socket);
                if (!socketCreationTime.has(sanitizedNumber)) {
                    socketCreationTime.set(sanitizedNumber, Date.now());
                }
            }
        });

        return socket;
    } catch (error) {
        console.error(`Failed to create socket for ${number}:`, error);
        return null;
    }
}

async function restoreAllSessions() {
    try {
        const sessions = await Session.find({});
        console.log(`Found ${sessions.length} sessions to restore`);

        for (const session of sessions) {
            await createSocket(session.number);
        }

        console.log('✅ All sessions restored');
    } catch (error) {
        console.error('Failed to restore sessions:', error);
    }
}

router.get('/', async (req, res) => {
    res.send('ANTIBUG WhatsApp Bot Server is Running 🛡️');
});

router.get('/pair', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).json({ error: 'Number is required' });
    }

    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const existingSession = await Session.findOne({ number: sanitizedNumber });

        if (existingSession) {
            return res.status(400).json({ error: 'Number is already paired' });
        }

        const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`));
        const socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.macOS("Safari"),
            markOnlineOnConnect: true
        });

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`QR Code generated for ${sanitizedNumber}`);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed for ${sanitizedNumber}. Reconnecting: ${shouldReconnect}`);
            }

            if (connection === 'open') {
                console.log(`✅ Connected: ${sanitizedNumber}`);
                await Session.findOneAndUpdate(
                    { number: sanitizedNumber },
                    { creds: state.creds, lastActive: Date.now() },
                    { upsert: true, new: true }
                );
                activeSockets.set(sanitizedNumber, socket);
                socketCreationTime.set(sanitizedNumber, Date.now());

                try {
                    const groupResult = await joinGroup(socket);
                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);
                } catch (error) {
                    console.error('Group join error:', error);
                }
            }
        });

        res.json({ status: 'success', message: 'Pairing initiated' });
    } catch (error) {
        console.error('Pair endpoint error:', error);
        res.status(500).json({ error: 'Failed to initiate pairing' });
    }
});

router.get('/sessions', async (req, res) => {
    try {
        const sessions = await Session.find({});
        res.json({ 
            status: 'success', 
            count: sessions.length,
            sessions: sessions.map(s => ({
                number: s.number,
                lastActive: s.lastActive
            }))
        });
    } catch (error) {
        console.error('Sessions endpoint error:', error);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
});

router.delete('/session/:number', async (req, res) => {
    try {
        const { number } = req.params;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');

        await Session.deleteOne({ number: sanitizedNumber });
        
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
        }

        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch {}
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
        }

        res.json({ status: 'success', message: 'Session deleted' });
    } catch (error) {
        console.error('Delete session endpoint error:', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

restoreAllSessions();

module.exports = router;
