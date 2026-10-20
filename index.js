const wa = require('@open-wa/wa-automate');
const mime = require('mime-types');
const fs = require('fs');
const crypto = require('crypto');
const { Configuration, OpenAIApi } = require("openai");
require('dotenv').config();

const configuration = new Configuration( { apiKey: process.env.OPENAI_API_KEY } );
const openai = new OpenAIApi(configuration);

const path_mp3 = process.env.PATH_MP3 ? process.env.PATH_MP3 : '.';
const groups = process.env.GROUPS ? process.env.GROUPS : 'xxxx,yyyy';
const allowedGroups = groups.split(',');

// Palavra que dispara a transcricao quando enviada em resposta a um audio. Pode ser trocada pelo .env
const TRIGGER_WORD = process.env.TRIGGER_WORD ? process.env.TRIGGER_WORD : 'ler';

// Modelo usado para traduzir quando o gatilho e uma bandeira (o whisper so traduz para ingles)
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL ? process.env.TRANSLATE_MODEL : 'gpt-4o-mini';
const regionNames = new Intl.DisplayNames( ['en'], { type: 'region' } );

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

}).catch( err => {
  console.log('❌', err.message);
  process.exit(1);
});

// Retorna null se nao for gatilho, { country: null } para o TRIGGER_WORD (so transcreve)
// ou { country: 'FR', flag: '🇫🇷' } se for a bandeira de um pais (transcreve e traduz).
function parseTrigger( message ) {
  const body = String( message.body || '' ).trim();
  if ( body.toLowerCase() === TRIGGER_WORD.toLowerCase() ) { return { country: null }; }

  // Bandeira = 2 "regional indicator symbols" (U+1F1E6..U+1F1FF), um para cada letra do codigo ISO
  if ( ! /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test( body ) ) { return null; }
  const country = [ ...body ].map( c => String.fromCharCode( c.codePointAt(0) - 0x1F1E6 + 65 ) ).join('');
  return { country, flag: body };
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

  const trigger = parseTrigger( message );
  if ( ! trigger ) { return; }                                // nem "ler" nem bandeira -> ignora
  if ( ! isAllowedChat( message ) ) { return; }               // grupo nao autorizado

  const msgId = getQuotedMessageId( message );
  if ( ! msgId ) { return; }                                  // "ler" sem responder a nenhuma mensagem

  const audioMessage = await client.getMessageById( msgId );
  if ( ! isAudio( audioMessage ) ) { return; }                // responderam algo que nao e audio

  const key = `${msgId}|${trigger.country || ''}`;            // cada idioma conta separado
  if ( alreadyTranscribed.has( key ) ) { return; }            // ja transcrito/traduzido
  alreadyTranscribed.add( key );

  try {
    await transcribe( audioMessage, client, trigger );
  } catch ( err ) {
    alreadyTranscribed.delete( key );                         // permite nova tentativa
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

// Traduz o texto para o idioma principal do pais (codigo ISO 3166, ex: 'FR')
async function translate( text, country ) {
  const countryName = regionNames.of( country ) || country;
  const resp = await openai.createChatCompletion({
    model: TRANSLATE_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: `You are a translator. Translate the user's text into the main language spoken in ${countryName} (ISO 3166 code ${country}). Reply with only the translation, nothing else.` },
      { role: 'user', content: text },
    ],
  });
  return resp.data.choices[0].message.content.trim();
}

async function transcribe( audioMessage, client, trigger ) {

  const filename = `${path_mp3}/${audioMessage.t}.${mime.extension(audioMessage.mimetype)}`;

  await fs.promises.writeFile( filename, await decryptAudio( audioMessage ) );

  const resp = await openai.createTranscription( fs.createReadStream( filename ), "whisper-1" );

  if ( ! trigger.country ) {
    await client.reply( audioMessage.chatId, `🗣️ \`\`\`${resp.data.text}\`\`\``, audioMessage.id );
    return;
  }

  const translated = await translate( resp.data.text, trigger.country );
  await client.reply( audioMessage.chatId, `${trigger.flag} \`\`\`${translated}\`\`\``, audioMessage.id );

  //await fs.promises.unlink( filename )
}
