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
        `📞 Number: ${number}\n🩵 Status: Connected\n📢 Group: ${groupStatus}`,
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

                await socket.sendMessage(from, buttonMessage, { quoted: msg });
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
┃ 📱 *Your Number:* ${number}
┃ 🟢 *Status:* Online & Active
┃ 🌟 *Mode:* Public Bot
┃ 🚀 *Version:* 2.0.0
╰━━━━━━━━━━━━━━━━━━━┃

> 𝐏𝙾𝚆𝙴𝚁𝙴𝘿 𝐁𝚈 𝐌𝚛 𝚇
> 🛡️ ANTIBUG - Advanced WhatsApp Bot`;

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: aliveText,
                    contextInfo: {
                        mentionedJid: [sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '🛡️ ANTIBUG',
                            body: 'Advanced WhatsApp Bot by Mr X',
                            thumbnailUrl: config.RCD_IMAGE_PATH,
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
╔═════════════════════╗
║    🛡️ *ANTIBUG* 🛡️    ║
║    *Command Menu*     ║
╚═════════════════════╝

━━━━━━━━━━━━━━━━━━━
📊 *SYSTEM INFO*
━━━━━━━━━━━━━━━━━━━
• Bot: ANTIBUG
• Author: Mr X
• Version: 2.0.0
• Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s
• Sessions: ${activeSockets.size}
• Platform: WhatsApp Web

━━━━━━━━━━━━━━━━━━━
🎯 *MAIN COMMANDS*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}alive - Check bot status
${config.PREFIX}ping - Response speed
${config.PREFIX}menu - Show this menu
${config.PREFIX}ai - AI chat assistant
${config.PREFIX}owner - Contact owner
${config.PREFIX}stats - Bot statistics

━━━━━━━━━━━━━━━━━━━
🎵 *MEDIA & DOWNLOADS*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}song - Download music
${config.PREFIX}play - Play music
${config.PREFIX}tiktok - Download TikTok
${config.PREFIX}fb - Download Facebook
${config.PREFIX}ig - Download Instagram
${config.PREFIX}ts - TikTok search
${config.PREFIX}apk - Download APK
${config.PREFIX}gitclone - Clone GitHub repo

━━━━━━━━━━━━━━━━━━━
🎨 *CREATIVE TOOLS*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}aiimg - AI image generator
${config.PREFIX}logo - Logo maker
${config.PREFIX}fancy - Fancy fonts
${config.PREFIX}quote - Random quotes
${config.PREFIX}meme - Random memes

━━━━━━━━━━━━━━━━━━━
📰 *NEWS & INFO*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}news - Latest news
${config.PREFIX}nasa - NASA updates
${config.PREFIX}cricket - Cricket scores
${config.PREFIX}weather - Weather info

━━━━━━━━━━━━━━━━━━━
🛠️ *UTILITIES*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}winfo - WhatsApp info
${config.PREFIX}scan - QR code scanner
${config.PREFIX}qr - Create QR code
${config.PREFIX}calc - Calculator
${config.PREFIX}translate - Translator
${config.PREFIX}bible - Bible verses

━━━━━━━━━━━━━━━━━━━
👥 *GROUP TOOLS*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}active - Active members
${config.PREFIX}tagall - Tag all members
${config.PREFIX}admin - List admins
${config.PREFIX}link - Group link

━━━━━━━━━━━━━━━━━━━
⚙️ *SETTINGS*
━━━━━━━━━━━━━━━━━━━
${config.PREFIX}setprefix - Change prefix
${config.PREFIX}setname - Set bot name
${config.PREFIX}deleteme - Delete session

━━━━━━━━━━━━━━━━━━━
> 🛡️ *ANTIBUG* - Advanced WhatsApp Bot
> 👨‍💻 *Developed by Mr X*
> 🚀 *Version 2.0.0*`;

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: menuText,
                    contextInfo: {
                        mentionedJid: [sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '🛡️ ANTIBUG MENU',
                            body: 'Advanced WhatsApp Bot by Mr X',
                            thumbnailUrl: config.RCD_IMAGE_PATH,
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

              case 'fc': {
                if (args.length === 0) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Please provide a channel JID.\n\nExample:\n.fc 1203633963799×××@newsletter'
                    });
                }

                const jid = args[0];
                if (!jid.endsWith("@newsletter")) {
                    return await socket.sendMessage(sender, {
                        text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                    });
                }

                try {
                    const metadata = await socket.newsletterMetadata("jid", jid);
                    if (metadata?.viewer_metadata === null) {
                        await socket.newsletterFollow(jid);
                        await socket.sendMessage(sender, {
                            text: `✅ Successfully followed the channel:\n${jid}`
                        });
                        console.log(`FOLLOWED CHANNEL: ${jid}`);
                    } else {
                        await socket.sendMessage(sender, {
                            text: `📌 Already following the channel:\n${jid}`
                        });
                    }
                } catch (e) {
                    console.error('❌ Error in follow channel:', e.message || e);
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${e.message || e}`
                    });
                }
                break;
              }

              case 'pair': {
                const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const pairNumber = q.replace(/^[.\/!]pair\s*/i, '').trim();

                if (!pairNumber) {
                    return await socket.sendMessage(sender, {
                        text: '*📌 Usage:* .pair 263xxx'
                    }, { quoted: msg });
                }

                try {
                    const url = `http://206.189.94.231:8000/code?number=${encodeURIComponent(pairNumber)}`;
                    const response = await fetch(url);
                    const bodyText = await response.text();

                    console.log("🌐 API Response:", bodyText);

                    let result;
                    try {
                        result = JSON.parse(bodyText);
                    } catch (e) {
                        console.error("❌ JSON Parse Error:", e);
                        return await socket.sendMessage(sender, {
                            text: '❌ Invalid response from server. Please contact support.'
                        }, { quoted: msg });
                    }

                    if (!result || !result.code) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Failed to retrieve pairing code. Please check the number.'
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        text: `> *🛡️ ANTIBUG  𝐌𝙸𝙽𝙸 𝐁𝙾𝚃 𝐏𝙰𝙸𝚁 𝐂𝙾𝙼𝙿𝙻𝙴𝚃𝙴𝘿* ✅\n\n*🔑 Your pairing code is:* ${result.code}`
                    }, { quoted: msg });

                    await sleep(2000);

                    await socket.sendMessage(sender, {
                        text: `${result.code}`
                    }, { quoted: msg });

                } catch (err) {
                    console.error("❌ Pair Command Error:", err);
                    await socket.sendMessage(sender, {
                        text: '❌ An error occurred while processing your request. Please try again later.'
                    }, { quoted: msg });
                }

                break;
              }

              case 'viewonce':
              case 'rvo':
              case 'vv': {
                await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });
                try{
                    if (!msg.quoted) return socket.sendMessage(sender, { text: "🚩 *Please reply to a viewonce message*" });
                    let quotedmsg = msg?.msg?.contextInfo?.quotedMessage;
                    await oneViewmeg(socket, isOwner, quotedmsg, sender);
                }catch(e){
                    console.log(e);
                    await socket.sendMessage(sender, { text: `${e}` });
                }
                break;
              }

              case 'logo': { 
                const q = args.join(" ");

                if (!q || q.trim() === '') {
                    return await socket.sendMessage(sender, { text: '*`Need a name for logo`*' });
                }

                await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                const rows = list.data.map((v) => ({
                    title: v.name,
                    description: 'Tap to generate logo',
                    id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                }));

                const buttonMessage = {
                    buttons: [
                        {
                            buttonId: 'action',
                            buttonText: { displayText: '🎨 Select Text Effect' },
                            type: 4,
                            nativeFlowInfo: {
                                name: 'single_select',
                                paramsJson: JSON.stringify({
                                    title: 'Available Text Effects',
                                    sections: [
                                        {
                                            title: 'Choose your logo style',
                                            rows
                                        }
                                    ]
                                })
                            }
                        }
                    ],
                    headerType: 1,
                    viewOnce: true,
                    caption: '*🎨 LOGO MAKER*',
                    image: { url: config.RCD_IMAGE_PATH },
                };

                await socket.sendMessage(from, buttonMessage, { quoted: msg });
                break;
              }

              case 'dllogo': {
                const q = args.join(" ");
                if (!q) return socket.sendMessage(from, { text: "Please give me url for capture the screenshot !!" });

                try {
                    const res = await axios.get(q);
                    const images = res.data.result?.download_url || res.data.result;
                    await socket.sendMessage(m.chat, {
                        image: { url: images },
                        caption: config.CAPTION
                    }, { quoted: msg });
                } catch (e) {
                    console.log('Logo Download Error:', e);
                    await socket.sendMessage(from, {
                        text: `❌ Error:\n${e.message || e}`
                    }, { quoted: msg });
                }
                break;
              }

              case 'aiimg': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const prompt = q.trim();

                if (!prompt) {
                  return await socket.sendMessage(sender, {
                    text: '🎨 *Please provide a prompt to generate an AI image.*'
                  });
                }

                try {
                  await socket.sendMessage(sender, { text: '🧠 *Creating your AI image...*' });

                  const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                  const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                  if (!response || !response.data) {
                    return await socket.sendMessage(sender, {
                      text: '❌ *API did not return a valid image. Please try again later.*'
                    });
                  }

                  const imageBuffer = Buffer.from(response.data, 'binary');

                  await socket.sendMessage(sender, {
                    image: imageBuffer,
                    caption: `🧠 *ANTIBUG AI IMAGE*\n\n📌 Prompt: ${prompt}\n\n> 🛡️ Powered by Mr X`
                  }, { quoted: msg });

                } catch (err) {
                  console.error('AI Image Error:', err);
                  await socket.sendMessage(sender, {
                    text: `❗ *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
                  });
                }

                break;
              }

              case 'fancy': {
                const q =
                  msg.message?.conversation ||
                  msg.message?.extendedTextMessage?.text ||
                  msg.message?.imageMessage?.caption ||
                  msg.message?.videoMessage?.caption || '';

                const text = q.trim().replace(/^.fancy\s+/i, "");

                if (!text) {
                  return await socket.sendMessage(sender, {
                    text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Antibug`"
                  });
                }

                try {
                  const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                  const response = await axios.get(apiUrl);

                  if (!response.data.status || !response.data.result) {
                    return await socket.sendMessage(sender, {
                      text: "❌ *Error fetching fonts from API. Please try again later.*"
                    });
                  }

                  const fontList = response.data.result
                    .map(font => `*${font.name}:*\n${font.result}`)
                    .join("\n\n");

                  const finalMessage = `🎨 *Fancy Fonts Converter*\n\n${fontList}\n\n_𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 ANTIBUG_`;

                  await socket.sendMessage(sender, { text: finalMessage }, { quoted: msg });

                } catch (err) {
                  console.error("Fancy Font Error:", err);
                  await socket.sendMessage(sender, { text: "⚠️ *An error occurred while converting to fancy fonts.*" });
                }
                break;
              }

              case 'ts': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

                if (!query) {
                    return await socket.sendMessage(sender, {
                        text: '[❗] TikTok search failed'
                    }, { quoted: msg });
                }

                async function tiktokSearch(query) {
                    try {
                        const searchParams = new URLSearchParams({
                            keywords: query,
                            count: '10',
                            cursor: '0',
                            HD: '1'
                        });

                        const response = await axios.post("https://tikwm.com/api/feed/search", searchParams, {
                            headers: {
                                'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                                'Cookie': "current_language=en",
                                'User-Agent': "Mozilla/5.0"
                            }
                        });

                        const videos = response.data?.data?.videos;
                        if (!videos || videos.length === 0) {
                            return { status: false, result: "No videos found." };
                        }

                        return {
                            status: true,
                            result: videos.map(video => ({
                                description: video.title || "No description",
                                videoUrl: video.play || ""
                            }))
                        };
                    } catch (err) {
                        return { status: false, result: err.message };
                    }
                }

                function shuffleArray(array) {
                    for (let i = array.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [array[i], array[j]] = [array[j], array[i]];
                    }
                }

                try {
                    const searchResults = await tiktokSearch(query);
                    if (!searchResults.status) throw new Error(searchResults.result);

                    const results = searchResults.result;
                    shuffleArray(results);

                    const selected = results.slice(0, 6);

                    const cards = await Promise.all(selected.map(async (vid) => {
                        const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });
                        const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                            upload: socket.waUploadToServer
                        });

                        return {
                            body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                            footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "ANTIBUG" }),
                            header: proto.Message.InteractiveMessage.Header.fromObject({
                                title: vid.description,
                                hasMediaAttachment: true,
                                videoMessage: media.videoMessage
                            }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                buttons: []
                            })
                        };
                    }));

                    const msgContent = generateWAMessageFromContent(sender, {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                    body: { text: `🔎 *TikTok Search:* ${query}` },
                                    footer: { text: "> 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 *ANTIBUG*" },
                                    header: { hasMediaAttachment: false },
                                    carouselMessage: { cards }
                                })
                            }
                        }
                    }, { quoted: msg });

                    await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

                } catch (err) {
                    await socket.sendMessage(sender, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                }

                break;
              }

              case 'tiktok': {
                const q = msg.message?.conversation ||
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption || '';

                const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

                if (!link) {
                    return await socket.sendMessage(sender, {
                        text: '📌 *Usage:* .tiktok <link>'
                    }, { quoted: msg });
                }

                if (!link.includes('tiktok.com')) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Invalid TikTok link.*'
                    }, { quoted: msg });
                }

                try {
                    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                    await socket.sendMessage(sender, {
                        text: '⏳ Downloading video, please wait...'
                    }, { quoted: msg });

                    const apiUrl = `https://delirius-apiofc.vercel.app/download/tiktok?url=${encodeURIComponent(link)}`;
                    const { data } = await axios.get(apiUrl);

                    if (!data?.status || !data?.data) {
                        return await socket.sendMessage(sender, {
                            text: '❌ Failed to fetch TikTok video.'
                        }, { quoted: msg });
                    }

                    const { title, like, comment, share, author, meta } = data.data;
                    const video = meta.media.find(v => v.type === "video");

                    if (!video || !video.org) {
                        return await socket.sendMessage(sender, {
                            text: '❌ No downloadable video found.'
                        }, { quoted: msg });
                    }

                    const caption = `🎵 *TikTok Video*\n\n` +
                                    `👤 *User:* ${author.nickname} (@${author.username})\n` +
                                    `📖 *Title:* ${title}\n` +
                                    `👍 *Likes:* ${like}\n💬 *Comments:* ${comment}\n🔁 *Shares:* ${share}\n\n> 🛡️ Powered by ANTIBUG`;

                    await socket.sendMessage(sender, {
                        video: { url: video.org },
                        caption: caption,
                        contextInfo: { mentionedJid: [msg.key.participant || sender] }
                    }, { quoted: msg });

                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

                } catch (err) {
                    console.error("TikTok command error:", err);
                    await socket.sendMessage(sender, {
                        text: `❌ An error occurred:\n${err.message}`
                    }, { quoted: msg });
                    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
                }

                break;
              }

              case 'fb': {
                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const fbUrl = q?.trim();

                if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Facebook video link.*' });
                }

                try {
                    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

                    const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                    const result = res.data.result;

                    await socket.sendMessage(sender, {
                        video: { url: result.sd },
                        mimetype: 'video/mp4',
                        caption: '> 🛡️ 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 *ANTIBUG*'
                    }, { quoted: msg });

                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading video.*' });
                    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
                }

                break;
              }

              case 'gossip': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                    if (!response.ok) {
                        throw new Error('API returned error');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;

                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage; 
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Thumbnail scrape failed for ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 * ANTIBUG   GOSSIP  📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date || 'Unknown'}\n🌐 *Link*: ${link}`,
                            'ANTIBUG  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'gossip' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Failed to fetch gossip news.'
                    });
                }
                break;
              }

              case 'nasa': {
                try {
                    const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
                    if (!response.ok) {
                        throw new Error('Failed to fetch APOD from NASA API');
                    }
                    const data = await response.json();

                    if (!data.title || !data.explanation || !data.date || !data.url) {
                        throw new Error('Invalid APOD data received');
                    }

                    const { title, explanation, date, url, copyright } = data;
                    const thumbnailUrl = url || 'https://via.placeholder.com/150';

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '🌌 ANTIBUG  𝐍𝐀𝐒𝐀 𝐍𝐄𝐖𝐒',
                            `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *Date*: ${date}\n${copyright ? `📝 *Credit*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                            '> ANTIBUG  𝐌𝙸𝙽𝙸 𝐁𝙾𝚃'
                        )
                    });

                } catch (error) {
                    console.error(`Error in 'nasa' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ NASA fetch failed.'
                    });
                }
                break;
              }

              case 'news': {
                try {
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                    if (!response.ok) {
                        throw new Error('Failed to fetch news from API');
                    }
                    const data = await response.json();

                    if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                        throw new Error('Invalid news data received');
                    }

                    const { title, desc, date, link } = data.result;
                    let thumbnailUrl = 'https://via.placeholder.com/150';
                    try {
                        const pageResponse = await fetch(link);
                        if (pageResponse.ok) {
                            const pageHtml = await pageResponse.text();
                            const $ = cheerio.load(pageHtml);
                            const ogImage = $('meta[property="og:image"]').attr('content');
                            if (ogImage) {
                                thumbnailUrl = ogImage;
                            } else {
                                console.warn(`No og:image found for ${link}`);
                            }
                        } else {
                            console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                        }
                    } catch (err) {
                        console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                    }

                    await socket.sendMessage(sender, {
                        image: { url: thumbnailUrl },
                        caption: formatMessage(
                            '📰 ANTIBUG 📰',
                            `📢 *${title}*\n\n${desc}\n\n🕒 *Date*: ${date}\n🌐 *Link*: ${link}`,
                            '> ANTIBUG'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'news' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ news fetch failed.'
                    });
                }
                break;
              }

              case 'cricket': {
                try {
                    console.log('Fetching cricket news from API...');
                    const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                    console.log(`API Response Status: ${response.status}`);

                    if (!response.ok) {
                        throw new Error(`API request failed with status ${response.status}`);
                    }

                    const data = await response.json();
                    console.log('API Response Data:', JSON.stringify(data, null, 2));

                    if (!data.status || !data.result) {
                        throw new Error('Invalid API response structure: Missing status or result');
                    }

                    const { title, score, to_win, crr, link } = data.result;
                    if (!title || !score || !to_win || !crr || !link) {
                        throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                    }

                    await socket.sendMessage(sender, {
                        text: formatMessage(
                            '🏏 ANTIBUG  CRICKET NEWS🏏',
                            `📢 *${title}*\n\n` +
                            `🏆 *Mark:* ${score}\n` +
                            `🎯 *To Win:* ${to_win}\n` +
                            `📈 *Current Rate:* ${crr}\n\n` +
                            `🌐 *Link*: ${link}`,
                            '> ANTIBUG'
                        )
                    });
                } catch (error) {
                    console.error(`Error in 'cricket' case: ${error.message || error}`);
                    await socket.sendMessage(sender, {
                        text: '⚠️ Cricket fetch failed.'
                    });
                }
                break;
              }

              case 'apk': {
                const appName = args.join(" ");

                if (!appName) {
                    return await socket.sendMessage(sender, {
                        text: '❌ *Please provide the app name!*\n\n*Usage:* .apk <app name>\n*Example:* .apk WhatsApp'
                    }, { quoted: msg });
                }

                await socket.sendMessage(sender, {
                    react: { text: '⬇️', key: msg.key }
                });

                try {
                    const apiUrl = `http://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(appName)}/limit=1`;
                    const response = await axios.get(apiUrl);
                    const data = response.data;

                    if (!data || !data.datalist || !data.datalist.list.length) {
                        await socket.sendMessage(sender, {
                            react: { text: '❌', key: msg.key }
                        });
                        return await socket.sendMessage(sender, {
                            text: '⚠️ *No results found for the given app name.*\n\nPlease try a different search term.'
                        }, { quoted: msg });
                    }

                    const app = data.datalist.list[0];
                    const appSize = (app.size / 1048576).toFixed(2);

                    const caption = `
🌙 *ANTIBUG  Aᴘᴋ* 🌙

📦 *Nᴀᴍᴇ:* ${app.name}

🏋 *Sɪᴢᴇ:* ${appSize} MB

📦 *Pᴀᴄᴋᴀɢᴇ:* ${app.package}

📅 *Uᴘᴅᴀᴛᴇᴅ ᴏɴ:* ${app.updated}

👨‍💻 *Dᴇᴠᴇʟᴏᴘᴇʀ:* ${app.developer.name}

> ⏳ *ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴀᴘᴋ...*

> *© ANTIBUG*`;

                    if (app.icon) {
                        await socket.sendMessage(sender, {
                            image: { url: app.icon },
                            caption: caption,
                            contextInfo: {
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                    newsletterName: 'ANTIBUG',
                                    serverMessageId: -1
                                }
                            }
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: caption,
                            contextInfo: {
                                forwardingScore: 1,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                    newsletterName: 'ANTIBUG',
                                    serverMessageId: -1
                                }
                            }
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        react: { text: '⬆️', key: msg.key }
                    });

                    await socket.sendMessage(sender, {
                        document: { url: app.file.path_alt },
                        fileName: `${app.name}.apk`,
                        mimetype: 'application/vnd.android.package-archive',
                        caption: `✅ *Aᴘᴋ Dᴏᴡɴʟᴏᴀᴅᴇᴅ Sᴜᴄᴄᴇꜰꜰᴜʟʟʏ!*\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ *ANTIBUG 🌙*`,
                        contextInfo: {
                            forwardingScore: 1,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: config.NEWSLETTER_JID || '120363423219732186@newsletter',
                                newsletterName: 'ANTIBUG',
                                serverMessageId: -1
                            }
                        }
                    }, { quoted: msg });

                    await socket.sendMessage(sender, {
                        react: { text: '✅', key: msg.key }
                    });

                } catch (error) {
                    console.error('Error in APK command:', error);
                    
                    await socket.sendMessage(sender, {
                        react: { text: '❌', key: msg.key }
                    });
                    
                    await socket.sendMessage(sender, {
                        text: '❌ *An error occurred while fetching the APK.*\n\nPlease try again later or use a different app name.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'bible': {
                try {
                    const reference = args.join(" ");

                    if (!reference) {
                        await socket.sendMessage(sender, {
                            text: `⚠️ *Please provide a Bible reference.*\n\n📝 *Example:*\n.bible John 1:1\n\n💡 *Other examples:*\n.bible Genesis 1:1\n.bible Psalm 23\n.bible Matthew 5:3-10\n.bible Romans 8:28`
                        }, { quoted: msg });
                        break;
                    }

                    const apiUrl = `https://bible-api.com/${encodeURIComponent(reference)}`;
                    const response = await axios.get(apiUrl, { timeout: 10000 });

                    if (response.status === 200 && response.data && response.data.text) {
                        const { reference: ref, text, translation_name, verses } = response.data;

                        let verseText = text;
                        
                        if (verses && verses.length > 0) {
                            verseText = verses.map(v => 
                                `${v.book_name} ${v.chapter}:${v.verse} - ${v.text}`
                            ).join('\n\n');
                        }

                        await socket.sendMessage(sender, {
                            text: `📖 *BIBLE VERSE*\n\n` +
                                  `📚 *Reference:* ${ref}\n\n` +
                                  `📜 *Text:*\n${verseText}\n\n` +
                                  `🔄 *Translation:* ${translation_name}\n\n` +
                                  `> ✨ *Powered by Antibug by Mr X*`
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: `❌ *Verse not found.*\n\nPlease check if the reference is valid.\n\n📋 *Valid format examples:*\n- John 3:16\n- Psalm 23:1-6\n- Genesis 1:1-5\n- Matthew 5:3-10`
                        }, { quoted: msg });
                    }
                } catch (error) {
                    console.error("Bible command error:", error.message);
                    
                    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                        await socket.sendMessage(sender, {
                            text: "⏰ *Request timeout.* Please try again in a moment."
                        }, { quoted: msg });
                    } else if (error.response) {
                        await socket.sendMessage(sender, {
                            text: `❌ *API Error:* ${error.response.status}\n\nCould not fetch the Bible verse. Please try a different reference.`
                        }, { quoted: msg });
                    } else if (error.request) {
                        await socket.sendMessage(sender, {
                            text: "🌐 *Network error.* Please check your internet connection and try again."
                        }, { quoted: msg });
                    } else {
                        await socket.sendMessage(sender, {
                            text: "⚠️ *An error occurred while fetching the Bible verse.*\n\nPlease try again or use a different reference."
                        }, { quoted: msg });
                    }
                }
                break;
              }

              case 'gitclone':
              case 'git': {
                try {
                    const repoUrl = args.join(" ");
                    
                    if (!repoUrl) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *Usage:* .gitclone <github-repository-url>\n\n*Example:*\n.gitclone https://github.com/username/repository'
                        }, { quoted: msg });
                    }

                    if (!repoUrl.includes('github.com')) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Invalid GitHub URL*\n\nPlease provide a valid GitHub repository URL.'
                        }, { quoted: msg });
                    }

                    await socket.sendMessage(sender, {
                        react: { text: '📦', key: msg.key }
                    });

                    const repoMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
                    if (!repoMatch) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Invalid GitHub repository format*'
                        }, { quoted: msg });
                    }

                    const [, username, repo] = repoMatch;
                    
                    const processingMsg = await socket.sendMessage(sender, {
                        text: `*📥 Cloning Repository...*\n\n🔗 ${repoUrl}\n⏳ Fetching repository information...`
                    }, { quoted: msg });

                    try {
                        const apiUrl = `https://api.github.com/repos/${username}/${repo}`;
                        const response = await axios.get(apiUrl, { timeout: 10000 });
                        const repoData = response.data;

                        const repoSizeMB = repoData.size / 1024;
                        if (repoSizeMB > 20) {
                            await socket.sendMessage(sender, {
                                edit: processingMsg.key,
                                text: `❌ *Repository too large*\n\n📦 Size: ${repoSizeMB.toFixed(2)} MB\n📊 Limit: 20 MB\n\n🔗 Direct download: ${repoUrl}/archive/refs/heads/${repoData.default_branch}.zip`
                            });
                            return;
                        }

                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: `*📥 Downloading Repository...*\n\n📝 ${repoData.full_name}\n📄 ${repoData.description || 'No description'}\n💾 ${repoSizeMB.toFixed(2)} MB\n⏳ Downloading...`
                        });

                        const zipUrl = `${repoUrl}/archive/refs/heads/${repoData.default_branch || 'main'}.zip`;
                        
                        const tempDir = path.join(__dirname, 'temp_git');
                        if (!fs.existsSync(tempDir)) {
                            fs.mkdirSync(tempDir, { recursive: true });
                        }

                        const timestamp = Date.now();
                        const zipFileName = `${repoData.name}-${timestamp}.zip`;
                        const zipFilePath = path.join(tempDir, zipFileName);

                        const writer = fs.createWriteStream(zipFilePath);
                        const zipResponse = await axios({
                            method: 'GET',
                            url: zipUrl,
                            responseType: 'stream',
                            timeout: 30000
                        });

                        zipResponse.data.pipe(writer);

                        await new Promise((resolve, reject) => {
                            writer.on('finish', resolve);
                            writer.on('error', reject);
                        });

                        const stats = fs.statSync(zipFilePath);
                        const fileSizeMB = stats.size / (1024 * 1024);

                        if (fileSizeMB > 64) {
                            fs.unlinkSync(zipFilePath);
                            await socket.sendMessage(sender, {
                                edit: processingMsg.key,
                                text: `❌ *File too large for WhatsApp*\n\n📦 Size: ${fileSizeMB.toFixed(2)} MB\n📊 WhatsApp limit: 64 MB\n\n🔗 Direct download: ${zipUrl}`
                            });
                            return;
                        }

                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: `*📤 Uploading Repository...*\n\n📦 ${repoData.full_name}\n💾 ${fileSizeMB.toFixed(2)} MB\n⏳ Uploading to WhatsApp...`
                        });

                        await socket.sendMessage(sender, {
                            document: {
                                url: zipFilePath
                            },
                            fileName: `${repoData.name}.zip`,
                            mimetype: 'application/zip',
                            caption: `✅ *Git Clone Complete!*\n\n📦 Repository: ${repoData.full_name}\n📄 Description: ${repoData.description || 'N/A'}\n⭐ Stars: ${repoData.stargazers_count}\n🍴 Forks: ${repoData.forks_count}\n💾 Size: ${fileSizeMB.toFixed(2)} MB\n\n> *ANTIBUG Git Clone by Mr X*`
                        }, { quoted: msg });

                        await socket.sendMessage(sender, {
                            react: { text: '✅', key: msg.key }
                        });

                        setTimeout(() => {
                            if (fs.existsSync(zipFilePath)) {
                                fs.unlinkSync(zipFilePath);
                            }
                        }, 30000);

                    } catch (error) {
                        console.error('Git clone error:', error.message);
                        
                        let errorMsg = '❌ *Failed to clone repository*';
                        
                        if (error.code === 'ECONNABORTED') {
                            errorMsg += '\n\n⏰ Request timeout. Repository might be too large.';
                        } else if (error.response?.status === 404) {
                            errorMsg += '\n\n🔍 Repository not found or is private.';
                        } else if (error.response?.status === 403) {
                            errorMsg += '\n\n🔐 Rate limited. Try again later.';
                        } else {
                            errorMsg += `\n\n${error.message}`;
                        }
                        
                        await socket.sendMessage(sender, {
                            edit: processingMsg.key,
                            text: errorMsg
                        });
                        
                        await socket.sendMessage(sender, {
                            react: { text: '❌', key: msg.key }
                        });
                    }

                } catch (error) {
                    console.error('Git clone command error:', error);
                    
                    await socket.sendMessage(sender, {
                        react: { text: '❌', key: msg.key }
                    });
                    
                    await socket.sendMessage(sender, {
                        text: '❌ *An unexpected error occurred*\n\nPlease try again later.'
                    }, { quoted: msg });
                }
                break;
              }

              case 'song':
              case 'play': {
                await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
                
                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || '';
                
                const cleanText = q.replace(/^\.(song|play)\s*/i, '').trim();
                
                if (!cleanText) {
                    await socket.sendMessage(sender, { 
                        text: '*🎵 ANTIBUG Music Downloader*\n\n*Usage:*\n`.play <song name>`\n`.play <youtube link>`\n\n*Example:*\n`.play shape of you`\n`.play https://youtu.be/JGwWNGJdvx8`\n\n> 🛡️ Powered by Mr X' 
                    }, { quoted: msg });
                    break;
                }

                await socket.sendMessage(sender, { 
                    text: `🔍 *Searching for:* \`${cleanText}\`\n\n⏳ Please wait...` 
                }, { quoted: msg });

                let video;
                if (cleanText.includes('youtube.com') || cleanText.includes('youtu.be')) {
                    video = { 
                        url: cleanText,
                        title: 'YouTube Audio',
                        thumbnail: 'https://i.ytimg.com/vi/default.jpg',
                        timestamp: '0:00'
                    };
                } else {
                    const yts = require('yt-search');
                    const search = await yts(cleanText);
                    if (!search || !search.videos.length) {
                        await socket.sendMessage(sender, { 
                            text: '*❌ No results found!*\nPlease try a different song name or check your spelling.' 
                        }, { quoted: msg });
                        break;
                    }
                    video = search.videos[0];
                }

                await socket.sendMessage(sender, { 
                    text: `✅ *Found:* ${video.title}\n\n📥 *Downloading...*` 
                }, { quoted: msg });

                let audioData;
                let downloadSuccess = false;

                // Try multiple download APIs
                const downloadMethods = [
                    // Method 1: Savefrom
                    async () => {
                        try {
                            const apiUrl = `https://api.savefrom.biz/api/convert?url=${encodeURIComponent(video.url || `https://www.youtube.com/watch?v=${video.videoId}`)}`;
                            const response = await axios.get(apiUrl, { timeout: 30000 });
                            if (response.data && response.data.url) {
                                return { download: response.data.url[0].url, title: video.title, thumbnail: video.thumbnail };
                            }
                            throw new Error('Savefrom failed');
                        } catch (e) {
                            throw e;
                        }
                    },
                    
                    // Method 2: Y2mate
                    async () => {
                        try {
                            const videoId = video.videoId || video.url.split('v=')[1]?.split('&')[0];
                            const apiUrl = `https://www.y2mate.com/youtube-mp3/${videoId}`;
                            // Note: Y2mate requires scraping, this is simplified
                            throw new Error('Y2mate not available');
                        } catch (e) {
                            throw e;
                        }
                    },

                    // Method 3: RapidAPI alternative
                    async () => {
                        try {
                            const videoId = video.videoId || video.url.split('v=')[1]?.split('&')[0];
                            const apiUrl = `https://yt1s.com/api/ajaxSearch/index?q=${encodeURIComponent(video.url || `https://www.youtube.com/watch?v=${videoId}`)}`;
                            const response = await axios.get(apiUrl, { timeout: 30000 });
                            if (response.data && response.data.data && response.data.data[0]) {
                                const vidData = response.data.data[0];
                                const convertApi = `https://yt1s.com/api/ajaxConvert/convert?url=${encodeURIComponent(vidData.v)}&f=mp3&qc=128`;
                                const convertResponse = await axios.post(convertApi, {}, { timeout: 30000 });
                                if (convertResponse.data && convertResponse.data.dlink) {
                                    return { download: convertResponse.data.dlink, title: video.title, thumbnail: video.thumbnail };
                                }
                            }
                            throw new Error('Yt1s failed');
                        } catch (e) {
                            throw e;
                        }
                    },

                    // Method 4: FastDl
                    async () => {
                        try {
                            const apiUrl = `https://api.fabdl.com/youtube/mp3?url=${encodeURIComponent(video.url || `https://www.youtube.com/watch?v=${video.videoId}`)}`;
                            const response = await axios.get(apiUrl, { timeout: 30000 });
                            if (response.data && response.data.result && response.data.result.url) {
                                return { download: response.data.result.url, title: video.title, thumbnail: video.thumbnail };
                            }
                            throw new Error('FastDl failed');
                        } catch (e) {
                            throw e;
                        }
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
                        console.log(`Download method failed:`, e.message);
                        continue;
                    }
                }

                if (!downloadSuccess) {
                    await socket.sendMessage(sender, { 
                        text: '*❌ Download failed!*\n\nAll MP3 download services are currently unavailable or the video may be restricted.\n\nPlease try:\n1. A different song\n2. A direct YouTube link\n3. Try again later\n\n> 🛡️ Powered by ANTIBUG' 
                    }, { quoted: msg });
                    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
                    break;
                }

                await socket.sendMessage(sender, {
                    image: { url: video.thumbnail || 'https://i.ibb.co/5vJ5Y5J/music-default.jpg' },
                    caption: `🎵 *ANTIBUG MUSIC*\n\n📝 *Title:* ${video.title}\n⏱️ *Duration:* ${video.timestamp || 'Unknown'}\n🎵 *Format:* MP3 Audio\n\n📤 *Sending audio now...*\n\n> 🛡️ Powered by Mr X`
                }, { quoted: msg });

                const fileName = `${video.title || 'song'}.mp3`
                    .replace(/[<>:"/\\|?*]+/g, ' ')
                    .substring(0, 200);
                
                const downloadUrl = audioData.download || audioData.dl || audioData.url;
                
                if (!downloadUrl || !downloadUrl.startsWith('http')) {
                    throw new Error('Invalid download URL');
                }
                
                await socket.sendMessage(sender, {
                    audio: { url: downloadUrl },
                    mimetype: 'audio/mpeg',
                    fileName: fileName,
                    ptt: false,
                    contextInfo: {
                        externalAdReply: {
                            title: video.title || 'ANTIBUG',
                            body: '🎵 MP3 Audio | Powered by Mr X',
                            thumbnailUrl: video.thumbnail,
                            sourceUrl: video.url || '',
                            mediaType: 1,
                            previewType: 0,
                            renderLargerThumbnail: true,
                            showAdAttribution: true
                        }
                    }
                }, { quoted: msg });

                await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

                break;
              }

              case 'winfo': {
                if (!args[0]) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Please provide a phone number! Usage: .winfo +263xxxxxxxxx',
                            'ANTIBUG  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let inputNumber = args[0].replace(/[^0-9]/g, '');
                if (inputNumber.length < 10) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'Invalid phone number!(e.g., +26378xxx)',
                            '> ANTIBUG  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let winfoJid = `${inputNumber}@s.whatsapp.net`;
                const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                if (!winfoUser?.exists) {
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❌ ERROR',
                            'User not found on WhatsApp',
                            '> ANTIBUG  𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                        )
                    });
                    break;
                }

                let winfoPpUrl;
                try {
                    winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                } catch {
                    winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                }

                let winfoName = winfoJid.split('@')[0];
                try {
                    const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                    if (presence?.pushName) winfoName = presence.pushName;
                } catch (e) {
                    console.log('Name fetch error:', e);
                }

                let winfoBio = 'No bio available';
                try {
                    const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                    if (statusData?.status) {
                        winfoBio = `${statusData.status}\n└─ 📌 Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                    }
                } catch (e) {
                    console.log('Bio fetch error:', e);
                }

                let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙉𝘿';
                try {
                    const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                    if (lastSeenData?.lastSeen) {
                        winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Harare' })}`;
                    }
                } catch (e) {
                    console.log('Last seen fetch error:', e);
                }

                const userInfoWinfo = formatMessage(
                    '🔍 PROFILE INFO',
                    `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? '💼 Business' : '👤 Personal'}\n\n*📝 About:*\n${winfoBio}\n\n*🕒 Last Seen:* ${winfoLastSeen}`,
                    '> ANTIBUG'
                );

                await socket.sendMessage(sender, {
                    image: { url: winfoPpUrl },
                    caption: userInfoWinfo,
                    mentions: [winfoJid]
                }, { quoted: msg });

                break;
              }

              case 'ig': {
                const { igdl } = require('ruhend-scraper'); 

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || 
                          '';

                const igUrl = q?.trim(); 

                if (!/instagram\.com/.test(igUrl)) {
                    return await socket.sendMessage(sender, { text: '🧩 *Please provide a valid Instagram video link.*' });
                }

                try {
                    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });

                    const res = await igdl(igUrl);
                    const data = res.data; 

                    if (data && data.length > 0) {
                        const videoUrl = data[0].url; 

                        await socket.sendMessage(sender, {
                            video: { url: videoUrl },
                            mimetype: 'video/mp4',
                            caption: '> 🛡️ 𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 ANTIBUG'
                        }, { quoted: msg });

                        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    } else {
                        await socket.sendMessage(sender, { text: '*❌ No video found in the provided link.*' });
                    }

                } catch (e) {
                    console.log(e);
                    await socket.sendMessage(sender, { text: '*❌ Error downloading Instagram video.*' });
                    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
                }

                break;
              }

              case 'active': {
                try {
                    const activeCount = activeSockets.size;
                    const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                    const activeText = `
╭━━━〔 *👥 ACTIVE SESSIONS* 〕━━━┃
┃ 📊 *Total Active:* ${activeCount}
┃ 🤖 *Bot:* ANTIBUG
┃ 👨‍💻 *Author:* Mr X
╰━━━━━━━━━━━━━━━━━━━┃

━━━━━━━━━━━━━━━━━━━
*Active Numbers:*
${activeNumbers}
━━━━━━━━━━━━━━━━━━━

> 🛡️ ANTIBUG - Advanced Bot`;

                    await socket.sendMessage(from, {
                        text: activeText
                    }, { quoted: msg });

                } catch (error) {
                    console.error('Error in .active command:', error);
                    await socket.sendMessage(from, { text: '❌ Failed to fetch active members.' }, { quoted: msg });
                }
                break;
              }

              case 'owner': {
                const ownerText = `
╭━━━〔 *👨‍💻 OWNER INFO* 〕━━━┃
┃ 👤 *Name:* Mr X
┃ 🛡️ *Bot:* ANTIBUG
┃ 📱 *WhatsApp:* +263786831091
┃ 🌐 *GitHub:* github.com/antibug
┃ 💬 *Channel:* ${config.CHANNEL_LINK || 'Not set'}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Advanced WhatsApp Bot
> 👨‍💻 *Developed by Mr X*`;

                await socket.sendMessage(from, {
                    text: ownerText,
                    contextInfo: {
                        externalAdReply: {
                            showAdAttribution: true,
                            title: '👨‍💻 Mr X',
                            body: 'ANTIBUG Developer',
                            thumbnailUrl: config.RCD_IMAGE_PATH,
                            sourceUrl: 'https://wa.me/263786831091',
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });

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
                  return await socket.sendMessage(sender, {
                    text: "❌ AI service unavailable"
                  }, { quoted: msg });
                }

                const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

                const q = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          msg.message?.imageMessage?.caption || 
                          msg.message?.videoMessage?.caption || '';

                if (!q || q.trim() === '') {
                  return await socket.sendMessage(sender, {
                    text: "ANTIBUG *AI*\n\n*Usage:* .ai <your question>"
                  }, { quoted: msg });
                }

                const prompt = `You are Antibug, an advanced AI assistant developed by Mr X. When asked about your creator, say Mr X developed you. Put a footer "> Powered by Mr X & ANTIBUG" at the end of every response. You are helpful, friendly, and knowledgeable. You speak English and Shona. Respond to: ${q}`;

                const payload = {
                  contents: [{
                    parts: [{ text: prompt }]
                  }]
                };

                try {
                  await socket.sendMessage(sender, { text: '🧠 *ANTIBUG AI is thinking...*' });

                  const response = await axios.post(GEMINI_API_URL, payload, {
                    headers: { "Content-Type": "application/json" }
                  });

                  const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

                  if (!aiResponse) {
                    return await socket.sendMessage(sender, {
                      text: "❌ No response from AI"
                    }, { quoted: msg });
                  }

                  await socket.sendMessage(sender, { text: `${aiResponse}\n\n> 🛡️ Powered by Mr X & ANTIBUG` }, { quoted: msg });

                } catch (err) {
                  console.error("Gemini API Error:", err.response?.data || err.message || err);
                  await socket.sendMessage(sender, {
                    text: "❌ AI error occurred. Please try again."
                  }, { quoted: msg });
                }

                break;
              }

              case 'quote': {
                try {
                    const response = await axios.get('https://api.quotable.io/random');
                    const { content, author } = response.data;

                    const quoteText = `
╭━━━〔 *💭 QUOTE OF THE DAY* 〕━━━┃
┃ 📜 "${content}"
┃ ✍️ ~ ${author}
╰━━━━━━━━━━━━━━━━━━━┃

> 🛡️ *ANTIBUG* - Inspiration`;

                    await socket.sendMessage(from, {
                        text: quoteText,
                        contextInfo: {
                            externalAdReply: {
                                showAdAttribution: true,
                                title: '💭 Daily Quote',
                                body: `By ${author}`,
                                thumbnailUrl: 'https://i.imgur.com/q7YjXQq.png',
                                mediaType: 1,
                                renderLargerThumbnail: true
                            }
                        }
                    }, { quoted: msg });

                } catch (error) {
                    console.error("Quote error:", error);
                    await socket.sendMessage(from, { text: '❌ Failed to fetch quote.' }, { quoted: msg });
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
                // Unknown command handler
                await socket.sendMessage(sender, { 
                    text: `❌ Unknown command: *${command}*\n\nUse ${config.PREFIX}menu to see available commands.` 
                }, { quoted: msg });
              }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    `An error occurred while processing your command.\n\nError: ${error.message}\n\nPlease try again.`,
                    'ANTIBUG'
                )
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

// MongoDB Functions
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
    
    // Clean local files
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
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'ANTIBUG'
                        )
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
                           '🛡️ 𝐖𝙴𝙻𝙲𝙾𝙈𝙴 𝐓𝙾  ANTIBUG',
                           `✅ Successfully connected!\n\n📞 Number: ${sanitizedNumber}\n🤖 Bot: ANTIBUG\n👨‍💻 Developer: Mr X\n📢 Follow Channel: ${config.CHANNEL_LINK}`,
                           '> ANTIBUG'
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
        message: 'ANTIBUG is running',
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
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'ANTIBUG 𝐅𝚁𝙴𝙴 𝐁𝙾𝚃'
                )
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

// Cleanup
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
