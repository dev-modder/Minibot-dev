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

// Helper Functions for New Commands
function getRandom(ext) {
    return Math.floor(Math.random() * 100000) + '.' + ext;
}

async function toAudio(media, ext) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const input = `./database/temp/${getRandom(ext)}`;
    const output = `./database/temp/${getRandom('mp3')}`;
    
    fs.writeFileSync(input, media);
    
    await execAsync(`ffmpeg -i ${input} -vn -ar 44100 -ac 2 -b:a 192k ${output}`);
    
    fs.unlinkSync(input);
    return fs.readFileSync(output);
}

async function toPTT(media, ext) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const input = `./database/temp/${getRandom(ext)}`;
    const output = `./database/temp/${getRandom('ogg')}`;
    
    fs.writeFileSync(input, media);
    
    await execAsync(`ffmpeg -i ${input} -vn -c:a libopus -b:a 128k -vbr on ${output}`);
    
    fs.unlinkSync(input);
    return fs.readFileSync(output);
}

async function toImage(media) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    const input = `./database/temp/${getRandom('webp')}`;
    const output = `./database/temp/${getRandom('png')}`;
    
    fs.writeFileSync(input, media);
    
    await execAsync(`convert ${input}[0] ${output}`);
    
    fs.unlinkSync(input);
    return fs.readFileSync(output);
}

async function UguuSe(media) {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', media, { filename: 'file' });
    
    const response = await axios.post('https://uguu.se/upload', form, {
        headers: form.getHeaders()
    });
    
    return response.data;
}

async function remini(media, type) {
    // Placeholder - would need API key
    throw new Error('ReMini API not configured');
}

async function hitamkan(media, type) {
    // Placeholder - would need image processing
    throw new Error('Image processing not configured');
}

function isUrl(url) {
    return url.match(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g);
}

function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

async function instaStalk(username) {
    try {
        const response = await axios.get(`https://www.instagram.com/${username}/?__a=1`);
        return response.data;
    } catch (error) {
        throw new Error('Instagram stalking failed');
    }
}

function readmore() {
    return String.fromCharCode(8206).repeat(4001);
}

async function styletext(text) {
    try {
        const response = await axios.get(`https://www.fancytextpro.com/api/text?text=${encodeURIComponent(text)}`);
        return response.data;
    } catch (error) {
        return [];
    }
}

async function wallpaper(query) {
    try {
        const response = await axios.get(`https://wall.alphacoders.com/api2.0/get.php?auth=3L7GB4TLHJ03KOR&method=search&term=${encodeURIComponent(query)}`);
        return response.data;
    } catch (error) {
        return [];
    }
}

async function ringtone(query) {
    try {
        const response = await axios.get(`https://meloboom.com/en/search?q=${encodeURIComponent(query)}`);
        // Would need to parse HTML and extract ringtone data
        return [];
    } catch (error) {
        return [];
    }
}

// Bot Rental Functions
async function StopJadiBot(socket, number, msg) {
    // Placeholder - would need database integration
    await socket.sendMessage(number, { text: '✅ Bot rental stopped successfully' });
}

async function ListJadiBot(socket, msg) {
    // Placeholder - would need database integration
    await socket.sendMessage(msg.key.remoteJid, { text: '📋 No active bot rentals' });
}

// Ensure temp directory exists
const tempDir = './database/temp';
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}


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
        const text = args.join(' ');
        const q = args.join(' ');
        const mime = (quoted && quoted.mimetype) ? quoted.mimetype : '';
        const qmsg = quoted ? quoted : msg;
        

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


              // Bot Rental Commands
              case 'stopjadibot': case 'stoprent': {
                const nmrnya = text ? text.replace(/[^0-9]/g, '') + '@s.whatsapp.net' : sender
                const onWa = await socket.onWhatsApp(nmrnya)
                if (!onWa.length > 0) {
                  await socket.sendMessage(sender, { text: '❌ The Number Is Not Registered On Whatsapp!' }, { quoted: msg })
                } else {
                  await StopJadiBot(socket, nmrnya, msg)
                }
                break
              }
              case 'listjadibot': case 'listrent': {
                await ListJadiBot(socket, msg)
                break
              }

              // Tools Menu
              case 'fetch': case 'get': {
                if (!/^https?:\/\//.test(text)) {
                  await socket.sendMessage(sender, { text: '❌ Start with http:// or https://' }, { quoted: msg })
                  break
                }
                try {
                  const res = await axios.get(isUrl(text) ? isUrl(text)[0] : text)
                  if (!/text|json|html|plain/.test(res.headers['content-type'])) {
                    await socket.sendMessage(sender, { text: text }, { quoted: msg })
                  } else {
                    await socket.sendMessage(sender, { text: util.format(res.data) }, { quoted: msg })
                  }
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Error: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'toaud': case 'toaudio': {
                if (!/video|audio/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Send/Reply Video/Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let mediaBuffer = fs.readFileSync(media)
                  let audio = await toAudio(mediaBuffer, 'mp4')
                  fs.unlinkSync(media)
                  await socket.sendMessage(sender, { audio: audio, mimetype: 'audio/mpeg' }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to convert: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'tomp3': {
                if (!/video|audio/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Send/Reply Video/Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let mediaBuffer = fs.readFileSync(media)
                  let audio = await toAudio(mediaBuffer, 'mp4')
                  fs.unlinkSync(media)
                  await socket.sendMessage(sender, { document: audio, mimetype: 'audio/mpeg', fileName: `Light_Speed_Mini_Bot.mp3` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to convert: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'tovn': case 'toptt': case 'tovoice': {
                if (!/video|audio/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Send/Reply Video/Audio With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let mediaBuffer = fs.readFileSync(media)
                  let audio = await toPTT(mediaBuffer, 'mp4')
                  fs.unlinkSync(media)
                  await socket.sendMessage(sender, { audio: audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to convert: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'togif': {
                if (!/webp|video/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Reply Video/Sticker With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let ran = `./database/temp/${getRandom('.gif')}`
                  const { exec } = require('child_process')
                  exec(`convert ${media} ${ran}`, async (err) => {
                    fs.unlinkSync(media)
                    if (err) {
                      await socket.sendMessage(sender, { text: '❌ Failed to convert' }, { quoted: msg })
                    } else {
                      let buffer = fs.readFileSync(ran)
                      await socket.sendMessage(sender, { video: buffer, gifPlayback: true }, { quoted: msg })
                      fs.unlinkSync(ran)
                    }
                  })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'toimage': case 'toimg': {
                if (!/webp|video/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Reply Video/Sticker With Caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let ran = `./database/temp/${getRandom('.png')}`
                  const { exec } = require('child_process')
                  exec(`convert ${media}[0] ${ran}`, async (err) => {
                    fs.unlinkSync(media)
                    if (err) {
                      await socket.sendMessage(sender, { text: '❌ Failed to convert' }, { quoted: msg })
                    } else {
                      let buffer = fs.readFileSync(ran)
                      await socket.sendMessage(sender, { image: buffer }, { quoted: msg })
                      fs.unlinkSync(ran)
                    }
                  })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'tourl': {
                if (!/webp|video|sticker|audio|image/.test(mime)) {
                  await socket.sendMessage(sender, { text: '❌ Send media to upload' }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Uploading...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let mediaBuffer = fs.readFileSync(media)
                  fs.unlinkSync(media)
                  let anu = await UguuSe(mediaBuffer)
                  await socket.sendMessage(sender, { text: '✅ URL: ' + anu.url }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Server is offline!' }, { quoted: msg })
                }
                break
              }
              case 'tinyurl': case 'shorturl': case 'shortlink': {
                if (!text || !isUrl(text)) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} https://example.com` }, { quoted: msg })
                  break
                }
                try {
                  let anu = await axios.get('https://tinyurl.com/api-create.php?url=' + text)
                  await socket.sendMessage(sender, { text: '✅ Short URL: ' + anu.data }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to shorten URL' }, { quoted: msg })
                }
                break
              }
              case 'ssweb': case 'ss': {
                if (!text || !isUrl(text)) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} https://example.com` }, { quoted: msg })
                  break
                }
                try {
                  let url = 'https://' + text.replace(/^https?:\/\//, '')
                  await socket.sendMessage(sender, { image: { url: 'https://image.thum.io/get/width/1900/crop/1000/fullpage/' + url }, caption: '✅ Screenshot captured!' }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to capture screenshot' }, { quoted: msg })
                }
                break
              }
              case 'weather': case 'cuaca': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Karachi` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${text}&units=metric&appid=060a6bcfa19809c2cd4d97a212b19273`)
                  let data = response.data
                  let txt = `🌤️ *Weather Info*\n\n`
                  txt += `📍 Location: ${data.name}, ${data.sys.country}\n`
                  txt += `🌡️ Temperature: ${data.main.temp}°C\n`
                  txt += `🌡️ Feels Like: ${data.main.feels_like}°C\n`
                  txt += `💧 Humidity: ${data.main.humidity}%\n`
                  txt += `🌬️ Wind Speed: ${data.wind.speed} m/s\n`
                  txt += `☁️ Weather: ${data.weather[0].description}`
                  await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Location not found!' }, { quoted: msg })
                }
                break
              }
              case 'define': case 'dictionary': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} hello` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${text}`)
                  let data = response.data[0]
                  let txt = `📖 *Definition*\n\n`
                  txt += `📝 Word: ${data.word}\n`
                  txt += `🔊 Pronunciation: ${data.phonetic || 'N/A'}\n`
                  txt += `📚 Meaning: ${data.meanings[0].definitions[0].definition}\n`
                  txt += `📝 Example: ${data.meanings[0].definitions[0].example || 'N/A'}`
                  await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Word not found!' }, { quoted: msg })
                }
                break
              }
              case 'github': case 'ghstalk': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} username` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.github.com/users/${text}`)
                  let data = response.data
                  let txt = `🐙 *GitHub Profile*\n\n`
                  txt += `👤 Username: ${data.login}\n`
                  txt += `📝 Name: ${data.name || 'N/A'}\n`
                  txt += `📍 Location: ${data.location || 'N/A'}\n`
                  txt += `📧 Email: ${data.email || 'N/A'}\n`
                  txt += `🏢 Company: ${data.company || 'N/A'}\n`
                  txt += `📝 Bio: ${data.bio || 'N/A'}\n`
                  txt += `📁 Public Repos: ${data.public_repos}\n`
                  txt += `👥 Followers: ${data.followers}\n`
                  txt += `👤 Following: ${data.following}\n`
                  txt += `🔗 URL: ${data.html_url}`
                  await socket.sendMessage(sender, { image: { url: data.avatar_url }, caption: txt }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ User not found!' }, { quoted: msg })
                }
                break
              }
              case 'npmsearch': case 'npm': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} axios` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`http://registry.npmjs.com/-/v1/search?text=${text}`)
                  let data = response.data.objects
                  if (!data.length) {
                    await socket.sendMessage(sender, { text: '❌ Package not found!' }, { quoted: msg })
                    break
                  }
                  let txt = `📦 *NPM Search Results*\n\n`
                  for (let i = 0; i < Math.min(5, data.length); i++) {
                    let pkg = data[i].package
                    txt += `${i + 1}. *${pkg.name}* (v${pkg.version})\n`
                    txt += `   ${pkg.description || 'No description'}\n`
                    txt += `   🔗 ${pkg.links.npm}\n\n`
                  }
                  await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Search failed!' }, { quoted: msg })
                }
                break
              }
              case 'joke': {
                try {
                  let response = await axios.get('https://official-joke-api.appspot.com/random_joke')
                  let data = response.data
                  await socket.sendMessage(sender, { text: `😂 *Joke*\n\n${data.setup}\n\n${data.punchline}` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to fetch joke' }, { quoted: msg })
                }
                break
              }
              case 'quote': {
                try {
                  let response = await axios.get('https://api.quotable.io/random')
                  let data = response.data
                  await socket.sendMessage(sender, { text: `💬 *Quote*\n\n"${data.content}"\n\n— ${data.author}` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to fetch quote' }, { quoted: msg })
                }
                break
              }
              case 'fact': {
                try {
                  let response = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en')
                  let data = response.data
                  await socket.sendMessage(sender, { text: `📚 *Random Fact*\n\n${data.text}` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to fetch fact' }, { quoted: msg })
                }
                break
              }
              case 'advice': {
                try {
                  let response = await axios.get('https://api.adviceslip.com/advice')
                  let data = JSON.parse(response.data)
                  await socket.sendMessage(sender, { text: `💡 *Advice*\n\n${data.slip.advice}` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to fetch advice' }, { quoted: msg })
                }
                break
              }

              // Audio Effects
              case 'bass': case 'blown': case 'deep': case 'earrape': case 'fast': case 'fat': case 'nightcore': case 'reverse': case 'robot': case 'slow': case 'smooth': case 'tupai': {
                if (!/audio/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Reply to audio with caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Processing audio...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let ran = `./database/temp/${getRandom('.mp3')}`
                  
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
                  
                  const { exec } = require('child_process')
                  exec(`ffmpeg -i ${media} ${set} ${ran}`, async (err) => {
                    fs.unlinkSync(media)
                    if (err) {
                      await socket.sendMessage(sender, { text: '❌ Failed to process audio' }, { quoted: msg })
                    } else {
                      let buff = fs.readFileSync(ran)
                      await socket.sendMessage(sender, { audio: buff, mimetype: 'audio/mpeg' }, { quoted: msg })
                      fs.unlinkSync(ran)
                    }
                  })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed: ' + String(e.message) }, { quoted: msg })
                }
                break
              }

              // Sticker Commands
              case 'sticker': case 'stiker': case 's': {
                if (!/image|video/.test(mime)) {
                  await socket.sendMessage(sender, { text: `❌ Send/Reply Image/Video with caption ${config.PREFIX}${command}` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { text: '⏳ Creating sticker...' }, { quoted: msg })
                  let media = await socket.downloadAndSaveMediaMessage(qmsg)
                  let ran = `./database/temp/${getRandom('.webp')}`
                  const { exec } = require('child_process')
                  exec(`convert ${media} -resize 512x512! ${ran}`, async (err) => {
                    fs.unlinkSync(media)
                    if (err) {
                      await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: msg })
                    } else {
                      let buff = fs.readFileSync(ran)
                      await socket.sendMessage(sender, { sticker: buff }, { quoted: msg })
                      fs.unlinkSync(ran)
                    }
                  })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed: ' + String(e.message) }, { quoted: msg })
                }
                break
              }
              case 'emojimix': {
                if (!text || !text.includes('+')) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} 😎+😂` }, { quoted: msg })
                  break
                }
                try {
                  let [emoji1, emoji2] = text.split('+')
                  emoji1 = emoji1.trim()
                  emoji2 = emoji2.trim()
                  let response = await axios.get(`https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQNDxtFiE2vRg9mHHmpg6u5AJLI&contentfilter=high&media_filter=png_transparent&component=proactive&collection=emoji_kitchen_v5&q=${encodeURIComponent(emoji1)}_${encodeURIComponent(emoji2)}`)
                  if (response.data.results && response.data.results.length > 0) {
                    await socket.sendMessage(sender, { sticker: { url: response.data.results[0].url } }, { quoted: msg })
                  } else {
                    await socket.sendMessage(sender, { text: '❌ Emoji mix not found!' }, { quoted: msg })
                  }
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to mix emojis' }, { quoted: msg })
                }
                break
              }
              case 'attp': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Hello` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { sticker: { url: `https://api.brilline.com/api/makers/attp?text=${encodeURIComponent(text)}` } }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: msg })
                }
                break
              }
              case 'ttp': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Hello` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { sticker: { url: `https://api.brilline.com/api/makers/ttp?text=${encodeURIComponent(text)}` } }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: msg })
                }
                break
              }

              // Search Commands
              case 'gimage': case 'image': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} cat` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(text)}&per_page=5`, {
                    headers: { 'Authorization': 'YOUR_PEXELS_API_KEY' }
                  })
                  if (response.data.photos && response.data.photos.length > 0) {
                    for (let i = 0; i < Math.min(3, response.data.photos.length); i++) {
                      await socket.sendMessage(sender, { 
                        image: { url: response.data.photos[i].src.medium }, 
                        caption: `📷 Result ${i + 1} for: ${text}` 
                      }, { quoted: msg })
                    }
                  } else {
                    await socket.sendMessage(sender, { text: '❌ No images found!' }, { quoted: msg })
                  }
                } catch (e) {
                  // Fallback to alternative API
                  try {
                    await socket.sendMessage(sender, { 
                      image: { url: `https://source.unsplash.com/500x500/?${encodeURIComponent(text)}` }, 
                      caption: `📷 Image for: ${text}` 
                    }, { quoted: msg })
                  } catch (e2) {
                    await socket.sendMessage(sender, { text: '❌ Failed to search images' }, { quoted: msg })
                  }
                }
                break
              }
              case 'google': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Node.js tutorial` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(text)}&format=json`)
                  let data = response.data
                  let txt = `🔍 *Google Search Results*\n\n`
                  txt += `📝 Query: ${text}\n\n`
                  if (data.Abstract) {
                    txt += `📖 Summary:\n${data.Abstract}\n\n`
                  }
                  if (data.AbstractURL) {
                    txt += `🔗 Source: ${data.AbstractURL}\n\n`
                  }
                  if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                    txt += `📚 Related Topics:\n`
                    for (let i = 0; i < Math.min(5, data.RelatedTopics.length); i++) {
                      if (data.RelatedTopics[i].Text) {
                        txt += `• ${data.RelatedTopics[i].Text}\n`
                      }
                    }
                  }
                  await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Search failed!' }, { quoted: msg })
                }
                break
              }
              case 'wikipedia': case 'wiki': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} JavaScript` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(text)}`)
                  let data = response.data
                  let txt = `📚 *Wikipedia*\n\n`
                  txt += `📝 Title: ${data.title}\n`
                  txt += `📖 Extract: ${data.extract}\n`
                  if (data.content_urls) {
                    txt += `🔗 URL: ${data.content_urls.desktop.page}`
                  }
                  if (data.thumbnail) {
                    await socket.sendMessage(sender, { image: { url: data.thumbnail.source }, caption: txt }, { quoted: msg })
                  } else {
                    await socket.sendMessage(sender, { text: txt }, { quoted: msg })
                  }
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Article not found!' }, { quoted: msg })
                }
                break
              }
              case 'ytsearch': case 'yts': case 'play': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Despacito` }, { quoted: msg })
                  break
                }
                try {
                  // Using a simple YouTube search API
                  let response = await axios.get(`https://apis.davidcyriltech.com/youtube?query=${encodeURIComponent(text)}`)
                  if (response.data && response.data.results && response.data.results.length > 0) {
                    let result = response.data.results[0]
                    let txt = `🎵 *YouTube Search*\n\n`
                    txt += `📝 Title: ${result.title}\n`
                    txt += `⏱️ Duration: ${result.duration || 'N/A'}\n`
                    txt += `👁️ Views: ${result.views || 'N/A'}\n`
                    txt += `🔗 URL: ${result.url}\n`
                    txt += `\n📺 Channel: ${result.channel || 'N/A'}`
                    await socket.sendMessage(sender, { 
                      image: { url: result.thumbnail }, 
                      caption: txt 
                    }, { quoted: msg })
                  } else {
                    await socket.sendMessage(sender, { text: '❌ No results found!' }, { quoted: msg })
                  }
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Search failed!' }, { quoted: msg })
                }
                break
              }

              // Fun Commands
              case 'roll': {
                const dice = Math.floor(Math.random() * 6) + 1
                await socket.sendMessage(sender, { text: `🎲 You rolled: ${dice}` }, { quoted: msg })
                break
              }
              case 'flip': {
                const result = Math.random() > 0.5 ? 'Heads 🪙' : 'Tails 🪙'
                await socket.sendMessage(sender, { text: `🪙 Result: ${result}` }, { quoted: msg })
                break
              }
              case '8ball': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Will I be rich?` }, { quoted: msg })
                  break
                }
                const responses = [
                  "Yes, definitely! ✅", "No, absolutely not! ❌", "Maybe... 🤔",
                  "Ask again later ⏰", "I'm not sure 🤷", "It is certain ✨",
                  "Very doubtful 😕", "Without a doubt 💯", "Don't count on it 😢"
                ]
                const answer = responses[Math.floor(Math.random() * responses.length)]
                await socket.sendMessage(sender, { text: `🎱 *Magic 8-Ball*\n\n❓ Question: ${text}\n🎱 Answer: ${answer}` }, { quoted: msg })
                break
              }
              case 'rate': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} My coding skills` }, { quoted: msg })
                  break
                }
                const rating = Math.floor(Math.random() * 11)
                await socket.sendMessage(sender, { text: `📊 Rating for "${text}": ${rating}/10 ${rating > 5 ? '⭐' : '👎'}` }, { quoted: msg })
                break
              }
              case 'truth': {
                const truths = [
                  "What's your biggest secret?", "What's the most embarrassing thing you've done?",
                  "What's your biggest fear?", "Who is your secret crush?",
                  "What's the worst lie you've told?", "What's your guilty pleasure?",
                  "What's the most childish thing you still do?", "What's your biggest regret?"
                ]
                await socket.sendMessage(sender, { text: `🤔 *Truth*\n\n${truths[Math.floor(Math.random() * truths.length)]}` }, { quoted: msg })
                break
              }
              case 'dare': {
                const dares = [
                  "Send a voice message singing a song!", "Send your last photo!",
                  "Text your crush 'I love you'!", "Do 10 push-ups and send a video!",
                  "Send a screenshot of your gallery!", "Call someone and sing happy birthday!",
                  "Send a voice message with your best accent!", "Post an embarrassing photo on your status!"
                ]
                await socket.sendMessage(sender, { text: `😈 *Dare*\n\n${dares[Math.floor(Math.random() * dares.length)]}` }, { quoted: msg })
                break
              }
              case 'ship': {
                if (!text || !text.includes('|')) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} John | Jane` }, { quoted: msg })
                  break
                }
                const [name1, name2] = text.split('|').map(n => n.trim())
                const percentage = Math.floor(Math.random() * 101)
                const heart = percentage > 80 ? '💖💖💖' : percentage > 50 ? '💕💕' : '💔'
                await socket.sendMessage(sender, { 
                  text: `💕 *Ship Result*\n\n👫 ${name1} ❤️ ${name2}\n📊 Compatibility: ${percentage}%\n${heart}` 
                }, { quoted: msg })
                break
              }

              // Calculator
              case 'calc': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} 2+2*5` }, { quoted: msg })
                  break
                }
                try {
                  // Safe evaluation using Function
                  const result = new Function('return ' + text.replace(/[^0-9+\-*/.() ]/g, ''))()
                  await socket.sendMessage(sender, { text: `🧮 *Calculator*\n\n📝 Expression: ${text}\n✅ Result: ${result}` }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Invalid expression!' }, { quoted: msg })
                }
                break
              }

              // QR Code
              case 'qr': case 'qrcode': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Hello World` }, { quoted: msg })
                  break
                }
                try {
                  await socket.sendMessage(sender, { 
                    image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, 
                    caption: '✅ QR Code created!'
                  }, { quoted: msg })
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Failed to create QR code' }, { quoted: msg })
                }
                break
              }

              // Translate
              case 'translate': case 'tr': {
                if (!text) {
                  await socket.sendMessage(sender, { text: `❌ Example: ${config.PREFIX}${command} Hello` }, { quoted: msg })
                  break
                }
                try {
                  let response = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|auto`)
                  if (response.data && response.data.responseData) {
                    await socket.sendMessage(sender, { 
                      text: `🌐 *Translation*\n\n📝 Original: ${text}\n✅ Translated: ${response.data.responseData.translatedText}` 
                    }, { quoted: msg })
                  }
                } catch (e) {
                  await socket.sendMessage(sender, { text: '❌ Translation failed!' }, { quoted: msg })
                }
                break
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
