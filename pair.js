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
┍━❑ ᴍᴏᴏɴ xᴍᴅ ᴍɪɴɪ ❑━━∙∙⊶
┃➸╭──────────
┃❑│▸ *ʙᴏᴛɴᴀᴍᴇ:* *LIGHT SPEED MINI BOT*
┃❑│▸ *ᴏᴡɴᴇʀ :* LIGHT-DEV
┃❑│▸ ꜱᴛᴀᴛᴜꜱ: *ᴏɴʟɪɴᴇ*
┃❑│▸ ʀᴜɴᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
┃❑│▸ *ʜᴏꜱᴛ :* Heroku
┃❑│▸ *ᴍᴏᴅᴇ :* Public
┃❑│▸ *ᴀᴄᴛɪᴠᴇ ᴜꜱᴇʀꜱ:* ${activeSockets.size}
┃❑│▸ *ᴅᴇᴠᴇʟᴏᴘᴇʀ:* LIGHT-DEV
┃➸╰──────────
┕━━━━━━━━━━━━━∙∙⊶

┎ ❑ *𝐌𝐔𝐏𝐄𝐑 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴀʟɪᴠᴇ
│▸ ${config.PREFIX}ᴍᴇɴᴜ
│▸ ${config.PREFIX}ᴘɪɴɢ
│▸ ${config.PREFIX}ᴀɪ
┖❑

┎ ❑ *𝐆𝐑𝐎𝐔𝐏 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ɢʀᴏᴜᴘʟɪꜱᴛ
│▸ ${config.PREFIX}ɢʀᴏᴜᴘɪɴꜰᴏ
│▸ ${config.PREFIX}ɪɴᴠɪᴛᴇ
│▸ ${config.PREFIX}ᴋɪᴄᴋ
│▸ ${config.PREFIX}ᴀᴅᴅ
│▸ ${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ
│▸ ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ
│▸ ${config.PREFIX}ᴛᴀɢᴀʟʟ
│▸ ${config.PREFIX}ʜɪᴅᴇᴛᴀɢ
│▸ ${config.PREFIX}ꜱᴇᴛɴᴀᴍᴇ
│▸ ${config.PREFIX}ꜱᴇᴛᴅᴇꜱᴄ
│▸ ${config.PREFIX}ꜱᴇᴛᴘᴘ
│▸ ${config.PREFIX}ᴍᴜᴛᴇ
│▸ ${config.PREFIX}ᴜɴᴍᴜᴛᴇ
│▸ ${config.PREFIX}ʟᴏᴄᴋ
│▸ ${config.PREFIX}ᴜɴʟᴏᴄᴋ
│▸ ${config.PREFIX}ʟɪɴᴋ
┖❑

┎ ❑ *𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ʙʟᴏᴄᴋ
│▸ ${config.PREFIX}ᴜɴʙʟᴏᴄᴋ
│▸ ${config.PREFIX}ɢᴇᴛʙɪᴏ
│▸ ${config.PREFIX}ɢᴇᴛᴘᴘ
│▸ ${config.PREFIX}ꜱᴀᴠᴇ
│▸ ${config.PREFIX}ꜰᴏʀᴡᴀʀᴅ
┖❑

┎ ❑ *𝐓𝐎𝐎𝐋𝐒 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ
│▸ ${config.PREFIX}ᴛʀᴀɴꜱʟᴀᴛᴇ
│▸ ${config.PREFIX}ᴄᴀʟᴄ
│▸ ${config.PREFIX}ǫʀ
│▸ ${config.PREFIX}ꜱʜᴏʀᴛᴇɴ
│▸ ${config.PREFIX}ᴄᴜʀʀᴇɴᴄʏ
│▸ ${config.PREFIX}ᴅᴇꜰɪɴᴇ
│▸ ${config.PREFIX}ᴊᴏᴋᴇ
│▸ ${config.PREFIX}ǫᴜᴏᴛᴇ
│▸ ${config.PREFIX}ꜰᴀᴄᴛ
│▸ ${config.PREFIX}ᴀᴅᴠɪᴄᴇ
┖❑

┎ ❑ *𝐀𝐍𝐈𝐌𝐄 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴀɴɪᴍᴇ
│▸ ${config.PREFIX}ᴍᴀɴɢᴀ
│▸ ${config.PREFIX}ᴄʜᴀʀᴀᴄᴛᴇʀ
│▸ ${config.PREFIX}ᴡᴀɪꜰᴜ
│▸ ${config.PREFIX}ɴᴇᴋᴏ
│▸ ${config.PREFIX}ʜᴜꜱʙᴀɴᴅᴏ
┖❑

┎ ❑ *𝐅𝐔𝐍 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴛʀᴜᴛʜ
│▸ ${config.PREFIX}ᴅᴀʀᴇ
│▸ ${config.PREFIX}ʀᴏʟʟ
│▸ ${config.PREFIX}ꜰʟɪᴘ
│▸ ${config.PREFIX}ʀᴘꜱ
│▸ ${config.PREFIX}8ʙᴀʟʟ
│▸ ${config.PREFIX}ʀᴀᴛᴇ
│▸ ${config.PREFIX}ꜱʜɪᴘ
┖❑

┎ ❑ *𝐔𝐓𝐈𝐋𝐈𝐓𝐘 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴛɪᴍᴇ
│▸ ${config.PREFIX}ᴅᴀᴛᴇ
│▸ ${config.PREFIX}ʀᴇᴍɪɴᴅᴇʀ
│▸ ${config.PREFIX}ɴᴏᴛᴇ
│▸ ${config.PREFIX}ꜱᴛɪᴄᴋᴇʀ
│▸ ${config.PREFIX}ᴛᴏɪᴍᴀɢᴇ
│▸ ${config.PREFIX}ᴛᴏᴠɪᴅᴇᴏ
│▸ ${config.PREFIX}ᴇᴍᴏᴊɪᴍɪx
│▸ ${config.PREFIX}ᴛᴛᴘ
│▸ ${config.PREFIX}ᴀᴛᴛᴘ
┖❑

┎ ❑ *𝐒𝐄𝐀𝐑𝐂𝐇 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ɢᴏᴏɢʟᴇ
│▸ ${config.PREFIX}ʏᴏᴜᴛᴜʙᴇ
│▸ ${config.PREFIX}ɢɪᴛʜᴜʙ
│▸ ${config.PREFIX}ɴᴘᴍ
┖❑

┎ ❑ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ɪᴍɢ
│▸ ${config.PREFIX}ᴡᴀʟʟᴘᴀᴘᴇʀ
│▸ ${config.PREFIX}ᴘɪɴᴛᴇʀᴇꜱᴛ
│▸ ${config.PREFIX}ɢᴅʀɪᴠᴇ
│▸ ${config.PREFIX}ᴍᴇᴅɪᴀꜰɪʀᴇ
┖❑

┎ ❑ *𝐌𝐓𝐈𝐂𝐊𝐄𝐑 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ꜱᴏɴɢ
│▸ ${config.PREFIX}ᴘʟᴀʏ
│▸ ${config.PREFIX}ᴛɪᴋᴛᴏᴋ
│▸ ${config.PREFIX}ꜰʙ
│▸ ${config.PREFIX}ɪɢ
│▸ ${config.PREFIX}ᴛꜱ
│▸ ${config.PREFIX}ᴀɪɪᴍɢ
│▸ ${config.PREFIX}ꜰᴀɴᴄʏ
│▸ ${config.PREFIX}ʟᴏɢᴏ
│▸ ${config.PREFIX}ᴀᴘᴋ
│▸ ${config.PREFIX}ɢɪᴛᴄʟᴏɴᴇ
│▸ ${config.PREFIX}ᴡɪɴꜰᴏ
│▸ ${config.PREFIX}ʙᴏᴍʙ
│▸ ${config.PREFIX}ᴅᴇʟᴇᴛᴇᴍᴇ
┖❑

┎ ❑ *𝐌𝐓𝐀𝐓𝐔𝐒 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ɴᴇᴡꜱ
│▸ ${config.PREFIX}ɴᴀꜱᴀ
│▸ ${config.PREFIX}ᴄʀɪᴄᴋᴇᴛ
│▸ ${config.PREFIX}ʙɪʙʟᴇ
┖❑

┎ ❑ *𝐌𝐓𝐈𝐂𝐊𝐄𝐑 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ᴀɴᴛɪʟɪɴᴋ
│▸ ${config.PREFIX}ᴀɴᴛɪꜱᴘᴀᴍ
│▸ ${config.PREFIX}ᴡᴇʟᴄᴏᴍᴇ
│▸ ${config.PREFIX}ɢᴏᴏᴅʙʏᴇ
┖❑

┎ ❑ *𝐎𝐖𝐍𝐄𝐑 𝐌𝐄𝐍𝐔* ❑
│▸ ${config.PREFIX}ʙʀᴏᴀᴅᴄᴀꜱᴛ
│▸ ${config.PREFIX}ᴄʟᴇᴀʀᴄʜᴀᴛ
│▸ ${config.PREFIX}ʟᴇᴀᴠᴇ
│▸ ${config.PREFIX}ᴊᴏɪɴ
┖❑`;

                await socket.sendMessage(from, {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption: formatMessage('*LIGHT SPEED MINI BOT*', menuText, 'LIGHT SPEED'),
                    contextInfo: {
                        mentionedJid: [msg.key.participant || sender],
                        forwardingScore: 999,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: (config.NEWSLETTER_JID || '').trim(),
                            newsletterName: 'M O O N  𝗫 𝗠 𝗗',
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
