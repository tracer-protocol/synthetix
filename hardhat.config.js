'use strict';
require('dotenv').config();

const path = require('path');

require('@nomiclabs/hardhat-truffle5');
require('@nomiclabs/hardhat-ethers');
require('solidity-coverage');
require('hardhat-gas-reporter');
require('hardhat-interact');

require('./hardhat');

const {
	constants: { inflationStartTimestampInSecs, AST_FILENAME, AST_FOLDER, BUILD_FOLDER },
} = require('.');

const CACHE_FOLDER = 'cache';

module.exports = {
	ovm: {
		solcVersion: '0.5.16',
	},
	solidity: {
		compilers: [
			{
				version: '0.4.25',
			},
			{
				version: '0.5.16',
			},
		],
	},
	paths: {
		sources: './contracts',
		ignore: /migrations\//,
		tests: './test/contracts',
		artifacts: path.join(BUILD_FOLDER, 'artifacts'),
		cache: path.join(BUILD_FOLDER, CACHE_FOLDER),

		// required for interact
		deployments: './deployments',
	},
	astdocs: {
		path: path.join(BUILD_FOLDER, AST_FOLDER),
		file: AST_FILENAME,
		ignores: 'test-helpers',
	},
	defaultNetwork: 'hardhat',
	networks: {
		hardhat: {
			blockGasLimit: 12e6,
			allowUnlimitedContractSize: true,
			initialDate: new Date(inflationStartTimestampInSecs * 1000).toISOString(),
			// Note: forking settings are injected at runtime by hardhat/tasks/task-node.js
		},
		localhost: {
			gas: 12e6,
			blockGasLimit: 12e6,
			url: 'http://localhost:8545',
		},
		mainnet: {
			url: process.env.PROVIDER_URL || 'http://localhost:8545',
			chainId: 1,
		},
		'mainnet-ovm': {
			url: process.env.PROVIDER_URL || 'https://mainnet.optimism.io/',
			chainId: 10,
		},
		kovan: {
			url: process.env.PROVIDER_URL || 'http://localhost:8545',
			chainId: 42,
		},
		'kovan-ovm': {
			url: process.env.PROVIDER_URL || 'https://kovan.optimism.io/',
			chainId: 420,
		},
	},
	gasReporter: {
		enabled: false,
		showTimeSpent: true,
		gasPrice: 20,
		currency: 'USD',
		maxMethodDiff: 25, // CI will fail if gas usage is > than this %
		outputFile: 'test-gas-used.log',
	},
	mocha: {
		timeout: 120e3, // 120s
	},
};
