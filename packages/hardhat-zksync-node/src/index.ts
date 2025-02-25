import { spawn } from 'child_process';
import { task, subtask, types } from 'hardhat/config';
import {
    TASK_COMPILE,
    TASK_TEST,
    TASK_TEST_GET_TEST_FILES,
    TASK_TEST_RUN_MOCHA_TESTS,
    TASK_TEST_RUN_SHOW_FORK_RECOMMENDATIONS,
    TASK_TEST_SETUP_TEST_ENVIRONMENT,
} from 'hardhat/builtin-tasks/task-names';
import { Provider } from 'zksync-web3';

import {
    MAX_PORT_ATTEMPTS,
    PLUGIN_NAME,
    START_PORT,
    TASK_NODE_ZKSYNC,
    TASK_NODE_ZKSYNC_CREATE_SERVER,
    TASK_NODE_ZKSYNC_DOWNLOAD_BINARY,
    TASK_RUN_NODE_ZKSYNC_IN_SEPARATE_PROCESS,
    ZKNODE_BIN_OWNER,
    ZKNODE_BIN_REPOSITORY_NAME,
} from './constants';
import { JsonRpcServer } from './server';
import {
    adjustTaskArgsForPort,
    configureNetwork,
    constructCommandArgs,
    getAssetToDownload,
    getAvailablePort,
    getLatestRelease,
    getPlatform,
    getRPCServerBinariesDir,
    isPortAvailable,
    waitForNodeToBeReady,
} from './utils';
import { RPCServerDownloader } from './downloader';
import { ZkSyncNodePluginError } from './errors';
import { ZkSyncProviderAdapter } from './zksync-provider-adapter';
import chalk from 'chalk';
import { HARDHAT_NETWORK_NAME } from 'hardhat/plugins';

// Subtask to download the binary
subtask(TASK_NODE_ZKSYNC_DOWNLOAD_BINARY, 'Downloads the JSON-RPC server binary')
    .addFlag('force', 'Force download even if the binary already exists')
    .setAction(
        async (
            {
                force,
            }: {
                force: boolean;
            },
            hre
        ) => {
            // Directory where the binaries are stored
            const rpcServerBinaryDir = await getRPCServerBinariesDir();

            // Get the latest release of the binary
            const latestRelease = await getLatestRelease(ZKNODE_BIN_OWNER, ZKNODE_BIN_REPOSITORY_NAME, PLUGIN_NAME);
            const downloader: RPCServerDownloader = new RPCServerDownloader(rpcServerBinaryDir, latestRelease.tag_name);

            // Check if the binary is already downloaded
            if (!force && (await downloader.isDownloaded())) {
                return downloader.getBinaryPath();
            }

            // Download the binary
            const assetToDownload: any = await getAssetToDownload(latestRelease);
            await downloader.download(assetToDownload.browser_download_url);

            return downloader.getBinaryPath();
        }
    );

// Subtask to create the server
subtask(TASK_NODE_ZKSYNC_CREATE_SERVER, 'Creates a JSON-RPC server for zkSync node')
    .addParam('binaryPath', 'Path to the binary file', undefined, types.string)
    .setAction(
        async (
            {
                binaryPath,
            }: {
                binaryPath: string;
            },
            hre
        ) => {
            // Create the server
            const server: JsonRpcServer = new JsonRpcServer(binaryPath);

            return server;
        }
    );

// Main task of the plugin. It starts the server and listens for requests.
task(TASK_NODE_ZKSYNC, 'Starts a JSON-RPC server for zkSync node')
    .addOptionalParam('port', 'Port to listen on - default: 8011', undefined, types.int)
    .addOptionalParam('log', 'Log filter level (error, warn, info, debug) - default: info', undefined, types.string)
    .addOptionalParam(
        'logFilePath',
        'Path to the file where logs should be written - default: `era_test_node.log`',
        undefined,
        types.string
    )
    .addOptionalParam('cache', 'Cache type (none, disk, memory) - default: disk', undefined, types.string)
    .addOptionalParam(
        'cacheDir',
        'Cache directory location for `disk` cache - default: `.cache`',
        undefined,
        types.string
    )
    .addFlag('resetCache', 'Reset the local `disk` cache')
    .addOptionalParam(
        'showCalls',
        'Show call debug information (none, user, system, all) - default: none',
        undefined,
        types.string
    )
    .addOptionalParam(
        'showStorageLogs',
        'Show storage log information (none, read, write, all) - default: none',
        undefined,
        types.string
    )
    .addOptionalParam(
        'showVmDetails',
        'Show VM details information (none, all) - default: none',
        undefined,
        types.string
    )
    .addOptionalParam(
        'showGasDetails',
        'Show Gas details information (none, all) - default: none',
        undefined,
        types.string
    )
    .addFlag(
        'resolveHashes',
        'Try to contact openchain to resolve the ABI & topic names. It enabled, it makes debug log more readable, but will decrease the performance'
    )
    .addFlag(
        'devUseLocalContracts',
        'Loads the locally compiled system contracts (useful when doing changes to system contracts or bootloader)'
    )
    .addOptionalParam(
        'fork',
        'Starts a local network that is a fork of another network (testnet, mainnet, http://XXX:YY)',
        undefined,
        types.string
    )
    .addOptionalParam('forkBlockNumber', 'Fork at the specified block height', undefined, types.int)
    .addOptionalParam('replayTx', 'Transaction hash to replay', undefined, types.string)
    // .addFlag('force', 'Force download even if the binary already exists')
    .setAction(
        async (
            {
                port,
                log,
                logFilePath,
                cache,
                cacheDir,
                resetCache,
                showCalls,
                showStorageLogs,
                showVmDetails,
                showGasDetails,
                resolveHashes,
                devUseLocalContracts,
                fork,
                forkBlockNumber,
                replayTx,
            }: {
                port: number;
                log: string;
                logFilePath: string;
                cache: string;
                cacheDir: string;
                resetCache: boolean;
                showCalls: string;
                showStorageLogs: string;
                showVmDetails: string;
                showGasDetails: string;
                resolveHashes: boolean;
                devUseLocalContracts: boolean;
                fork: string;
                forkBlockNumber: number;
                replayTx: string;
            },
            { run }
        ) => {
            const commandArgs = constructCommandArgs({
                port,
                log,
                logFilePath,
                cache,
                cacheDir,
                resetCache,
                showCalls,
                showStorageLogs,
                showVmDetails,
                showGasDetails,
                resolveHashes,
                devUseLocalContracts,
                fork,
                forkBlockNumber,
                replayTx,
            });

            // Download the binary
            const binaryPath: string = await run(TASK_NODE_ZKSYNC_DOWNLOAD_BINARY, { force: false });

            // Create the server
            const server: JsonRpcServer = await run(TASK_NODE_ZKSYNC_CREATE_SERVER, { binaryPath });

            try {
                server.listen(commandArgs);
            } catch (error: any) {
                throw new ZkSyncNodePluginError(error.message);
            }
        }
    );

subtask(TASK_RUN_NODE_ZKSYNC_IN_SEPARATE_PROCESS, 'Runs a Hardhat node-zksync task in a separate process.')
    .addVariadicPositionalParam('taskArgs', 'Arguments for the Hardhat node-zksync task.')
    .setAction(async ({ taskArgs = [] }, hre) => {
        const currentPort = await getAvailablePort(START_PORT, MAX_PORT_ATTEMPTS);
        const adjustedArgs = adjustTaskArgsForPort(taskArgs, currentPort);

        const taskProcess = spawn('npx', ['hardhat', TASK_NODE_ZKSYNC, ...adjustedArgs], {
            detached: true, // This creates a separate process group
            // stdio: 'inherit',
        });

        return {
            process: taskProcess,
            port: currentPort,
        };
    });

task(
    TASK_TEST,
    async (
        {
            testFiles,
            noCompile,
            parallel,
            bail,
            grep,
        }: {
            testFiles: string[];
            noCompile: boolean;
            parallel: boolean;
            bail: boolean;
            grep?: string;
        },
        { run, network },
        runSuper
    ) => {
        if (network.zksync !== true || network.name !== HARDHAT_NETWORK_NAME) {
            return await runSuper();
        }

        const platform = getPlatform();
        if (platform === 'windows' || platform === '') {
            throw new ZkSyncNodePluginError(`Unsupported platform: ${platform}`);
        }

        if (!noCompile) {
            await run(TASK_COMPILE, { quiet: true });
        }

        const files = await run(TASK_TEST_GET_TEST_FILES, { testFiles });

        // Download the binary, if necessary
        const binaryPath: string = await run(TASK_NODE_ZKSYNC_DOWNLOAD_BINARY, { force: false });

        // Start the zkSync node using TASK_RUN_NODE_ZKSYNC_IN_SEPARATE_PROCESS
        const taskArgs: any[] = [
            /* Add necessary arguments here */
        ];
        const { process: taskProcess, port } = await run(TASK_RUN_NODE_ZKSYNC_IN_SEPARATE_PROCESS, {
            taskArgs: taskArgs,
        });

        await waitForNodeToBeReady(port);
        configureNetwork(network, port);

        let testFailures = 0;
        try {
            // Run the tests
            testFailures = await run(TASK_TEST_RUN_MOCHA_TESTS, {
                testFiles: files,
                parallel,
                bail,
                grep,
            });
        } finally {
            // Ensure we shut down the zkSync node after tests are done
            if (taskProcess) {
                try {
                    process.kill(-taskProcess.pid!);
                } catch (error: any) {
                    if (error.code !== 'ESRCH') {
                        // ESRCH means the process was already terminated
                        console.info(
                            chalk.red(`Failed to kill the zkSync node process when running tests: ${error.message}`)
                        );
                    }
                }
            }
        }

        process.exitCode = testFailures;
        return testFailures;
    }
);

export { ZkSyncProviderAdapter } from './zksync-provider-adapter';
