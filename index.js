const wa = require('@open-wa/wa-automate');
const mime = require('mime-types');
const fs = require('fs');
const { Configuration, OpenAIApi } = require("openai");
require('dotenv').config();

const configuration = new Configuration( { apiKey: process.env.OPENAI_API_KEY } );
const openai = new OpenAIApi(configuration);

const path_mp3 = process.env.PATH_MP3 ? process.env.PATH_MP3 : '.';
const sessionDataPath = process.env.PATH_SESSION ? process.env.PATH_SESSION : './';
const groups = process.env.GROUPS ? process.env.GROUPS : 'xxxx,yyyy';
const allowedGroups = groups.split(',');

// Emoji que dispara a transcricao. Pode ser trocado pelo .env
const TRIGGER_REACTION = process.env.TRIGGER_REACTION ? process.env.TRIGGER_REACTION : '🗣️';

// Evita transcrever o mesmo audio duas vezes (varias pessoas reagindo)
const alreadyTranscribed = new Set();

wa.create({
  useChrome: true,
  sessionId: "WhatsAppTranscription",
  multiDevice: true,          //required to enable multiDevice support
  authTimeout: 30,
  blockCrashLogs: true,
  disableSpins: true,
  headless: true,
  hostNotificationLang: 'PT_BR',
  logConsole: true,
  popup: true,
  qrTimeout: 300,
  sessionDataPath,
}).then( client => {

  // Unico gatilho: reaction no audio
  client.onReaction( async reaction => {
    if ( process.env.DEBUG ) { console.log('REACTION >>', reaction); }
    try {
      await processReaction( reaction, client );
    } catch ( err ) {
      console.log('Erro ao processar reaction:', err);
    }
  });

  if ( process.env.DEBUG ) {
    client.onAnyMessage( message => console.log('MESSAGE >>', message) );
  }

});

// 🗣 e 🗣️ sao o mesmo emoji com/sem variation selector (U+FE0F).
// Normalizar evita falso negativo dependendo do aparelho que reagiu.
function normalizeEmoji( text ) {
  return String( text || '' ).replace(/[\uFE0E\uFE0F\u200D]/g, '').trim();
}

function isTriggerReaction( reaction ) {
  const emoji = reaction.reactionText || reaction.text || '';
  return normalizeEmoji( emoji ) === normalizeEmoji( TRIGGER_REACTION );
}

// O id da mensagem reagida vem em campos diferentes conforme a versao da lib
function getReactedMessageId( reaction ) {
  const id = reaction.msgId || reaction.msgKey || reaction.parentMsgKey || null;
  return id ? id.toString() : null;
}

function isAllowedChat( message ) {
  return ( ! message.isGroupMsg ) || ( allowedGroups.indexOf( message.chatId ) !== -1 );
}

function isAudio( message ) {
  return !!( message && message.mimetype && message.mimetype.includes("audio") );
}

async function processReaction( reaction, client ) {

  if ( ! isTriggerReaction( reaction ) ) { return; }          // reaction diferente de 🗣️ -> ignora
  if ( reaction.orphan ) { return; }                          // reaction sem mensagem carregada

  const msgId = getReactedMessageId( reaction );
  if ( ! msgId ) { return console.log('Nao consegui identificar a mensagem da reaction'); }

  const audioMessage = await client.getMessageById( msgId );
  if ( ! isAudio( audioMessage ) ) { return; }                // reagiram em algo que nao e audio
  if ( ! isAllowedChat( audioMessage ) ) { return; }          // grupo nao autorizado

  if ( alreadyTranscribed.has( msgId ) ) { return; }          // ja transcrito
  alreadyTranscribed.add( msgId );

  try {
    await transcribe( audioMessage, client );
  } catch ( err ) {
    alreadyTranscribed.delete( msgId );                       // permite nova tentativa
    throw err;
  }
}

async function transcribe( audioMessage, client ) {

  const filename = `${path_mp3}/${audioMessage.t}.${mime.extension(audioMessage.mimetype)}`;
  const mediaData = await wa.decryptMedia( audioMessage );

  await fs.promises.writeFile( filename, mediaData );

  const resp = await openai.createTranscription( fs.createReadStream( filename ), "whisper-1" );

  await client.reply( audioMessage.chatId, `🗣️ \`\`\`${resp.data.text}\`\`\``, audioMessage.id );

  //await fs.promises.unlink( filename )
}
