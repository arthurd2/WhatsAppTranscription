FROM  openwa/wa-automate
USER root
# procps (`ps`, usado para matar o Chrome) e zstd (exigido pelo open-wa 5.x)
RUN rm -f /etc/apt/sources.list.d/google*.list && apt-get update && apt-get install -y --no-install-recommends procps zstd && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app/
RUN npm install --production
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["index.js"]
