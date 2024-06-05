const wa = require('@open-wa/wa-automate');
const mime = require('mime-types');
const fs = require('fs');
const { Configuration, OpenAIApi } = require("openai");

require('dotenv').config();
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
const path_mp3 = process.env.PATH_MP3 ? process.env.PATH_MP3 : '.' ;
const sessionDataPath = process.env.PATH_SESSION ? process.env.PATH_SESSION : './' ;
const groups = process.env.GROUPS ? process.env.GROUPS : 'xxxx,yyyy' ;
const allowedGroups = groups.split(',');

wa.create({
    useChrome: true,
    sessionId: "WhatsAppTranscription",
    multiDevice: true, //required to enable multiDevice support
    authTimeout: 60, //wait only 60 seconds to get a connection with the host account device
    blockCrashLogs: true,
    disableSpins: true,
    headless: true,
    hostNotificationLang: 'PT_BR',
    logConsole: true,
    popup: true,
    qrTimeout: 0, //0 means it will wait forever for you to scan the qr code
    sessionDataPath,
}).then(client => start(client));

function start(client) {
    client.onAnyMessage(async message => {
        console.log(message);

        if ((allowedGroups.includes(message.chatId) || !message.isGroupMsg) && message.type === "ptt") {
            const filename = `${path_mp3}/${message.id}.${mime.extension(message.mimetype)}`;
            const mediaData = await wa.decryptMedia(message);

            fs.writeFile(filename, mediaData, err => {
                if (err) { return console.log(err); }
                console.log('Voice file saved:', filename);
            });
        }

        if (message.body === "!ler" && message.quotedMsg && message.quotedMsg.type === "ptt") {
            const originalMessageId = message.quotedMsg.id;
            const filePath = `${path_mp3}/${originalMessageId}.${mime.extension(message.quotedMsg.mimetype)}`;

            if (fs.existsSync(filePath)) {
                const resp = await openai.createTranscription(fs.createReadStream(filePath), "whisper-1");
                console.log(`Transcribed text: ${resp.data.text}`);
                await client.reply(message.chatId, `🗣️ ${resp.data.text}`, message.id);
            } else {
                console.log('File not found for transcription:', filePath);
            }
        }
    });
}
