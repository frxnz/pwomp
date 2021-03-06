const promisify = require('promisify-node');
const chokidar = require('chokidar');
const fs = require('fs-extra');
const equal = require('deep-equal');
const glob = promisify('glob');
const handlebars = require('handlebars');
const minify = require('html-minifier').minify;
const path = require('path');
const putil = require('pwomp-util');
const config = require('../config');
const log = require('../log');
let packageJson;

try {
    packageJson = require(`${process.cwd()}/package.json`);
} catch(err) {}

class ViewCompiler {
    constructor() {
        this.isReady = false;
        this.queue = [];

        this.__layoutPrefix = path.normalize(`${config.getPath('layoutsDir').replace(config.getPath('viewsDir'), '').replace(/^[\\\/]/, '')}/`)
        this.__partialPrefix = path.normalize(`${config.getPath('partialsDir').replace(config.getPath('viewsDir'), '').replace(/^[\\\/]/, '')}/`)

        this.__init();
    }

    async compile() {

        if (!this.isReady) {
            this.queue.push(this.compile.bind(this));
            return;
        }

        this.views.map(await this.__createFileFromView.bind(this));

        log.success('Views compiled!');

    }

    async watch() {

        if (!this.isReady) {
            this.queue.push(this.watch.bind(this));
            return;
        }

        log.status('Watching views for changes');

        const watcher = chokidar.watch(`${config.getPath('viewsDir')}/**/*.hbs`, {
            awaitWriteFinish : {
                stabilityThreshold: 100,
                pollInterval: 100
            }
        });

        this.compile();

        watcher.on('add', handleChange.bind(this));
        watcher.on('change', handleChange.bind(this));
        watcher.on('unlink', handleDelete.bind(this));
        
        // todo: Watcher chokes when deleting a watched folder on Windows
        // https://github.com/paulmillr/chokidar/issues/566
        async function handleChange(filename) {
            log.status(`${filename} changed, compiling...`);
            // Parsing views is fast enough it makes sense/is safer to
            // recompile everything when a file is changed.
            await this.__parseViews();
            this.views.map(await this.__createFileFromView.bind(this));
            log.success(`${filename} updated`);
        }

        async function handleDelete(filename) {
            const ignorePaths = [
                config.getPath('layoutsDir'),
                config.getPath('partialsDir'),
            ];

            filename = putil.normalizePath(filename);

            const isIgnored = ignorePaths.find(p => filename.includes(p));

            if (isIgnored) return;

            log.status(`${filename} removed, deleting...`);
            await this.__deleteViewFile(filename);
            log.success(`${filename} deleted`);
        }

    }

    async __init() {
        await this.__parseViews();

        this.isReady = true;
        
        this.__processQueue();
    }

    __processQueue() {

        if (!this.queue.length) return;

        this.queue.forEach((func) => {
            func();
        });
    }

    async __parseViews() {
        const views = await this.__dirContentsToObject(config.getPath('viewsDir'));

        this.layouts = views.filter(v => v.type === 'layout') || [];
        this.partials = views.filter(v => v.type === 'partial') || [];
        this.views = views.filter(v => v.type === 'view') || [];

        this.__registerPartials();
        await this.__registerHelpers();
    }

    __registerPartials() {
        this.partials.forEach((partial) => {
            const name = partial.name.replace(this.__partialPrefix, '');
            handlebars.unregisterPartial(name);
            handlebars.registerPartial(name, partial.template);
        });
    }

    async __registerHelpers() {
        const helperFiles = await glob(`${config.HELPER_DIRECTORY}/**/*.js`);
        const externalHelperFiles = await glob(`${config.getPath('helpersDir')}/**/*.js`);
        const pwompHelperPlugins = Object.keys(packageJson.devDependencies).filter(key => key.match(/^pwomp-(?!cli$)/));

        [...helperFiles, ...externalHelperFiles, ...pwompHelperPlugins].forEach((file) => {
            try {
                const name = file.split('/').pop().replace('.js', '').replace(/^pwomp-/, '');
                handlebars.unregisterHelper(name);
                // todo: Hardcoding this path is problematic
                handlebars.registerHelper(name, require(file.includes('.js') ? path.resolve(file) : path.resolve(process.cwd(), 'node_modules', file)));
            } catch(err) {
                log.error(err);
            }
        });
    }

    async __dirContentsToObject(directory, ignore) {
        
        directory = putil.normalizePath(directory);

        try {
            const filenames = await glob(path.join(directory, `**/*.${config.SETTINGS.viewExtension}`), {
                ignore : ignore ? `{${ignore.join(',')}}/**` : null
            });
            return await Promise.all(filenames.map(putil.fileToViewObject.bind(this)));
        } catch (err) {
            log.error(err);
        }
    }

    async __createFileFromView(view) {
        log.status(`Compiling ${view.name}`);

        const isHomepage = view.name === 'index';
        const pathSuffix = isHomepage ? '.html' : '/index.html'
        const destinationPath = this.__getViewDestinationPath(view);
        let fullView;

        if (!('layout' in view.data)) {
            view.data.layout = config.SETTINGS.defaultLayout;
        }

        if (view.data.layout === 'none' || !this.layouts.length) {
            fullView = view.template;
        } else {
            const layoutName = path.normalize(`${config.getPath('layoutsDir').replace(config.getPath('viewsDir'), '').replace(/^[\\\/]/, '')}/${view.data.layout}`);
            const layout = this.layouts.find(l => l.name === layoutName);
            fullView = layout.template.replace(config.SETTINGS.layoutReplacer, view.template);
        }

        try {
            const compiled = handlebars.compile(fullView)(view.data);
            const out = await fs.outputFile(destinationPath, minify(compiled, config.SETTINGS.minifyOptions));
        } catch(err) {
            log.error(`Error compiling ${view.name}: ${err}`);
        }
    }

    async __deleteViewFile(filename) {
        const viewName = putil.getViewNameFromFilename(filename);
        const destinationPath = this.__getViewDestinationPath(viewName);
        const destination = viewName === 'index' ? destinationPath : destinationPath.replace('/index.html', '');

        try {
            // todo: Recursively delete parent directories if empty, for nested views
            await fs.remove(destination);
        } catch(err) {
            log.error(err);
        }
    }

    __getViewDestinationPath(view) {
        const name = typeof view === 'object' ? view.name : view;
        const isHomepage = name === 'index';
        const pathSuffix = isHomepage ? '.html' : '/index.html'
        return `${config.SETTINGS.outputDir}${name}${pathSuffix}`;
    }
}

module.exports = ViewCompiler;