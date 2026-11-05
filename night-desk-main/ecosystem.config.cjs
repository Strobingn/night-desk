module.exports = {
  apps: [
    {
      name: "night-desk",
      script: "scripts/start-paper.mjs",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: {
        LIVE_TRADING: "false",
        DEMO_FEED: "1",
        FEED_MODE: "auto",
        PORT: "4721",
        NODE_ENV: "production"
      }
    }
  ]
};
