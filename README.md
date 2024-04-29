Update .env with your OpenAI API key and make sure you are using NodeJS >= 16.

You can find more information about OpenAI here: https://platform.openai.com/overview

You need ffmpeg installed to convert audio files: https://ffmpeg.org

`npm install`

`node index.js`

The console will show the QR code that you need to read using WhatsApp's option to link a device.
When you link your device, you need to wait for the application to sync with WhatsApp. This may take a while.
It will be ready when you see this message in the console:

🚀 @OPEN-WA ready for account: XXXX

Enjoy.

# Docker
```shell
docker build . -t whats
```
# Docker Compose
```yaml
version: "3.5"
services:
  speech2text2:
    image: whats
    restart: always
    environment:
       - OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxx
       - GROUPS=aaaaaaaa-bbbbbbb@g.us,yyyyyyyyy-xxxxxxxx@g.us
       - PATH_MP3=/mp3
       - PATH_SESSION=/session
    volumes:
       - session:/session
       - mp3:/mp3
volumes:
  session:
    driver: local
    driver_opts:
      type: none
      device: /full/path/to/WhatsAppTranscription/session
      o: bind
  mp3:
    driver: local
    driver_opts:
      type: none
      device: /full/path/to//WhatsAppTranscription/mp3
      o: bind
```
