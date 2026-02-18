module.exports = {
    apps: [
        {
            name: 'mcp-gateway',
            script: './src/index.js',
            instances: 1,
            exec_mode: 'fork',
            watch: false,
            env: {
                NODE_ENV: 'production',
                PORT: 3002,
            },
            env_production: {
                NODE_ENV: 'production',
                PORT: 3002,
            },
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            restart_delay: 3000,
            max_restarts: 10,
        },
    ],
};
