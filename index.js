const wa = require('@open-wa/wa-automate');
const mime = require('mime-types');
const fs = require('fs');
const crypto = require('crypto');
const { Configuration, OpenAIApi } = require("openai");
require('dotenv').config();

const configuration = new Configuration( { apiKey: process.env.OPENAI_API_KEY } );
const openai = new OpenAIApi(configuration);

const path_mp3 = process.env.PATH_MP3 ? process.env.PATH_MP3 : '.';
const sessionDataPath = process.env.PATH_SESSION ? process.env.PATH_SESSION : './';
const groups = process.env.GROUPS ? process.env.GROUPS : 'xxxx,yyyy';
const allowedGroups = groups.split(',');

// Palavra que dispara a transcricao quando enviada em resposta a um audio. Pode ser trocada pelo .env
const TRIGGER_WORD = process.env.TRIGGER_WORD ? process.env.TRIGGER_WORD : 'ler';

// Evita transcrever o mesmo audio duas vezes (varias pessoas pedindo)
const alreadyTranscribed = new Set();

// Verifica a chave e os creditos da OpenAI antes de subir o WhatsApp.
// A OpenAI nao tem endpoint de saldo: a unica forma de saber se ha creditos e fazer uma
// chamada real. Transcrevemos 1s de silencio (custo ~US$ 0,0001) e checamos se vem "insufficient_quota".
async function checkOpenAI() {
  if ( ! process.env.OPENAI_API_KEY ) { throw new Error('OPENAI_API_KEY nao definida'); }

  try {
    await openai.retrieveModel('whisper-1');                  // valida a chave e o acesso ao whisper
  } catch ( err ) {
    throw new Error( `Chave da OpenAI invalida ou sem acesso ao whisper-1: ${openAIErrorMessage( err )}` );
  }

  const filename = `${path_mp3}/openai-check.wav`;
  await fs.promises.writeFile( filename, silentWav( 1 ) );
  try {
    await openai.createTranscription( fs.createReadStream( filename ), "whisper-1" );
  } catch ( err ) {
    throw new Error( `Sem creditos ou com limite estourado na OpenAI: ${openAIErrorMessage( err )}` );
  } finally {
    await fs.promises.unlink( filename ).catch( () => {} );
  }
}

function openAIErrorMessage( err ) {
  const data = err.response && err.response.data && err.response.data.error;
  return data ? `${data.code || err.response.status} - ${data.message}` : err.message;
}

// WAV PCM 16-bit mono 16kHz so com silencio
function silentWav( seconds ) {
  const rate = 16000, dataSize = rate * 2 * seconds;
  const buf = Buffer.alloc( 44 + dataSize );
  buf.write('RIFF', 0); buf.writeUInt32LE( 36 + dataSize, 4 ); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE( 16, 16 ); buf.writeUInt16LE( 1, 20 ); buf.writeUInt16LE( 1, 22 );
  buf.writeUInt32LE( rate, 24 ); buf.writeUInt32LE( rate * 2, 28 ); buf.writeUInt16LE( 2, 32 ); buf.writeUInt16LE( 16, 34 );
  buf.write('data', 36); buf.writeUInt32LE( dataSize, 40 );
  return buf;
}

checkOpenAI().then( () => {
  console.log('✅ OpenAI: chave valida e com creditos');
  return wa.create({
    useChrome: true,
    sessionId: "WhatsAppTranscription",
    multiDevice: true,          //required to enable multiDevice support
    authTimeout: 30,
    blockCrashLogs: true,
    disableSpins: true,
    headless: true,
    hostNotificationLang: 'pt-br',
    logConsole: true,
    popup: true,
    qrTimeout: 300,
    sessionDataPath,
    chromiumArgs: ['--no-sandbox'], // container roda como root
  });
}).then( client => {

  // Unico gatilho: responder ao audio com "ler".
  // onAnyMessage (e nao onMessage) para aceitar tambem o "ler" enviado pela propria conta.
  client.onAnyMessage( async message => {
    if ( process.env.DEBUG ) { console.log('MESSAGE >>', message); }
    try {
      await processMessage( message, client );
    } catch ( err ) {
      console.log('Erro ao processar mensagem:', err);
    }
  });

  // O open-wa 5.x so grava a sessao (PATH_SESSION/<sessionId>.data.json) ao parar o client.
  // No container o node e o PID 1 e ignora SIGTERM sem handler -> docker mata com SIGKILL e a sessao se perde.
  let stopping = false;
  const shutdown = async signal => {
    if ( stopping ) { return; }
    stopping = true;
    console.log(`${signal} recebido, salvando sessao...`);
    try {
      await client.stop('signal');
    } catch ( err ) {
      console.log('Erro ao encerrar o client:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

}).catch( err => {
  console.log('❌', err.message);
  process.exit(1);
});

function isTriggerMessage( message ) {
  return String( message.body || '' ).trim().toLowerCase() === TRIGGER_WORD.toLowerCase();
}

// Id da mensagem citada (o audio ao qual o "ler" respondeu)
function getQuotedMessageId( message ) {
  const quoted = message.quotedMsgObj || message.quotedMsg;
  const id = quoted && quoted.id;
  return id ? ( id._serialized || id ).toString() : null;
}

function isAllowedChat( message ) {
  return ( ! message.isGroupMsg ) || ( allowedGroups.indexOf( message.chatId ) !== -1 );
}

function isAudio( message ) {
  return !!( message && message.mimetype && message.mimetype.includes("audio") );
}

async function processMessage( message, client ) {

  if ( ! isTriggerMessage( message ) ) { return; }            // mensagem diferente de "ler" -> ignora
  if ( ! isAllowedChat( message ) ) { return; }               // grupo nao autorizado

  const msgId = getQuotedMessageId( message );
  if ( ! msgId ) { return; }                                  // "ler" sem responder a nenhuma mensagem

  const audioMessage = await client.getMessageById( msgId );
  if ( ! isAudio( audioMessage ) ) { return; }                // responderam algo que nao e audio

  if ( alreadyTranscribed.has( msgId ) ) { return; }          // ja transcrito
  alreadyTranscribed.add( msgId );

  try {
    await transcribe( audioMessage, client );
  } catch ( err ) {
    alreadyTranscribed.delete( msgId );                       // permite nova tentativa
    throw err;
  }
}

// O @open-wa/decrypt 5.x chama decipher.final() sobre o arquivo inteiro, mas o WhatsApp
// anexa um MAC de 10 bytes ao fim do arquivo cifrado -> "wrong final block length".
// Aqui baixamos e decriptamos manualmente, descartando o MAC.
async function decryptAudio( message ) {
  const url = ( message.deprecatedMms3Url || message.clientUrl || '' ).trim();
  if ( ! url || ! message.mediaKey ) { throw new Error('Mensagem de audio sem url/mediaKey'); }

  const res = await fetch( url, { headers: { 'User-Agent': 'WhatsApp/2.16.352', Origin: 'https://web.whatsapp.com/', Referer: 'https://web.whatsapp.com/' } } );
  if ( ! res.ok ) { throw new Error(`Falha ao baixar audio: HTTP ${res.status}`); }
  const encrypted = Buffer.from( await res.arrayBuffer() ).subarray( 0, -10 );   // remove o MAC

  const expanded = Buffer.from( crypto.hkdfSync( 'sha256', Buffer.from( message.mediaKey, 'base64' ), Buffer.alloc(32), 'WhatsApp Audio Keys', 112 ) );
  const decipher = crypto.createDecipheriv( 'aes-256-cbc', expanded.subarray(16, 48), expanded.subarray(0, 16) );
  return Buffer.concat( [ decipher.update( encrypted ), decipher.final() ] );
}

async function transcribe( audioMessage, client ) {

  const filename = `${path_mp3}/${audioMessage.t}.${mime.extension(audioMessage.mimetype)}`;

  await fs.promises.writeFile( filename, await decryptAudio( audioMessage ) );

  const resp = await openai.createTranscription( fs.createReadStream( filename ), "whisper-1" );

  await client.reply( audioMessage.chatId, `🗣️ \`\`\`${resp.data.text}\`\`\``, audioMessage.id );

  //await fs.promises.unlink( filename )
}
