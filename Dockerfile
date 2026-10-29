FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY conformance ./conformance
ENV PORT=8787 OICT_TEST_HOOKS=1
EXPOSE 8787
USER node
CMD ["node", "src/server/main.ts"]
