const log = require('../log');
const server = require('../server');
const ViewCompiler = require('../compilers/views');
const SassCompiler = require('../compilers/sass');

function serve() {

    // Run compilers
    const viewCompiler = new ViewCompiler();
    viewCompiler.watch();

    const sassCompiler = new SassCompiler();
    sassCompiler.watch();

    // Start server
    log.status('Preparing site server...');

    const site = server();

    // Handle kill process
    process.on('SIGINT', function() {
        // todo: Figure out why process doesn't always exit immediately
        log.status('Closing site server...');
        site.close(() => {
            log.success('Bye 👋');
            process.exit();
        });
    });

}

module.exports = serve;