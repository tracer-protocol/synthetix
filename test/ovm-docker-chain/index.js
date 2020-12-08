const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const ethers = require('ethers');
const axios = require('axios');

const { parseEther } = ethers.utils;

const { assert } = require('../contracts/common');
const testUtils = require('../utils');
const { ensureDeploymentPath, loadAndCheckRequiredSources } = require('../../publish/src/util');

const { wrap, constants, toBytes32 } = require('../..');

const commands = {
	build: require('../../publish/src/commands/build').build,
	deploy: require('../../publish/src/commands/deploy').deploy,
};

describe('L1/L2 integration', () => {
	let setupProvider, getContract;

	const overrides = {
		gasPrice: '0',
		gasLimit: 1.5e6,
	};

	const network = 'local';
	const { getPathToNetwork } = wrap({ path, fs, network });

	const wallets = [];
	const deploymentPaths = [];
	let currentDeploymentPath;
	let deployerPrivateKey;
	let l1Provider, l2Provider;

	const createTempLocalCopy = ({ prefix, useOvm }) => {
		const folderPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		fs.copySync(getPathToNetwork({ network: 'goerli', useOvm: useOvm }), folderPath);
		fs.writeFileSync(
			path.join(folderPath, constants.DEPLOYMENT_FILENAME),
			JSON.stringify({ targets: {}, sources: {} }, null, '\t')
		);

		return folderPath;
	};

	const prepareFreshDeployment = (network = 'local', deploymentPath) => {
		ensureDeploymentPath(deploymentPath);
		// get the (local) config file
		const { config, configFile } = loadAndCheckRequiredSources({
			deploymentPath,
			network,
		});
		// switch to true
		Object.keys(config).map(source => {
			config[source] = { deploy: true };
		});
		fs.writeFileSync(configFile, JSON.stringify(config));
	};

	// fetches an array of both instance contracts
	const fetchContract = ({ contract, source = contract, instance, user }) =>
		getContract({
			contract,
			source,
			network,
			deploymentPath: deploymentPaths[instance],
			wallet: user || wallets[instance],
		});

	const connectBridgesAndSyncCaches = async (
		l1MessengerAddress,
		l2MessengerAddress,
		l1ToL2Bridge,
		l2ToL1Bridge
	) => {
		let importedContracts = ['ext:Messenger', 'ovm:SynthetixBridgeToBase'];
		let importedAddresses = [l1MessengerAddress, l2ToL1Bridge.address];
		let addressResolver = fetchContract({ contract: 'AddressResolver', instance: 0 });
		await addressResolver.importAddresses(
			importedContracts.map(toBytes32),
			importedAddresses,
			overrides
		);
		await l1ToL2Bridge.setResolverAndSyncCache(addressResolver.address, overrides);

		importedContracts = ['ext:Messenger', 'base:SynthetixBridgeToOptimism'];
		importedAddresses = [l2MessengerAddress, l1ToL2Bridge.address];
		addressResolver = fetchContract({ contract: 'AddressResolver', instance: 1 });
		await addressResolver.importAddresses(
			importedContracts.map(toBytes32),
			importedAddresses,
			overrides
		);
		await l2ToL1Bridge.setResolverAndSyncCache(addressResolver.address, overrides);
	};

	before('set up test utils', async () => {
		({ setupProvider, getContract } = testUtils());
	});

	before('setup providers and deployer wallets', async () => {
		({ wallet: wallets[0], provider: l1Provider } = setupProvider({
			providerUrl: 'http://127.0.0.1:9545',
			privateKey: '0x6fcb386bca1dd44b31a33e371a2cc26a039f72732396f2bbc88d8a50ba13fcc4',
		}));

		({ wallet: wallets[1], provider: l2Provider } = setupProvider({
			providerUrl: 'http://127.0.0.1:8545',
			privateKey: wallets[0].privateKey,
		}));

		deployerPrivateKey = wallets[0].privateKey;
	});

	before('deploy instance on L1', async () => {
		currentDeploymentPath = createTempLocalCopy({ prefix: 'snx-docker-local-1-' });
		// currentDeploymentPath =
		// 	'/var/folders/fc/sr3_lv5x4bvdj688l8c20pn40000gp/T/snx-docker-local-1-5n7XTn';
		console.log(currentDeploymentPath);
		deploymentPaths.push(currentDeploymentPath);
		// ensure that we do a fresh deployment
		prepareFreshDeployment(network, currentDeploymentPath);
		// compile contracts
		await commands.build({ showContractSize: true });

		await commands.deploy({
			network,
			freshDeploy: true,
			yes: true,
			providerUrl: 'http://127.0.0.1:9545',
			privateKey: deployerPrivateKey,
			deploymentPath: currentDeploymentPath,
			gasPrice: '0',
		});
	});

	before('deploy an OVM instance', async () => {
		currentDeploymentPath = createTempLocalCopy({
			prefix: 'snx-docker-local-2-ovm-',
			useOvm: true,
		});
		// currentDeploymentPath =
		// 	'/var/folders/fc/sr3_lv5x4bvdj688l8c20pn40000gp/T/snx-docker-local-2-ovm-c78ag4';
		console.log(currentDeploymentPath);
		deploymentPaths.push(currentDeploymentPath);
		// ensure that we do a fresh deployment
		prepareFreshDeployment(network, currentDeploymentPath);
		// compile with the useOVM flag set
		await commands.build({ showContractSize: true, useOvm: true });

		await commands.deploy({
			network,
			freshDeploy: true,
			yes: true,
			providerUrl: 'http://127.0.0.1:8545',
			privateKey: deployerPrivateKey,
			useOvm: true,
			deploymentPath: currentDeploymentPath,
			methodCallGasLimit: '2500000',
			contractDeploymentGasLimit: '11000000',
			gasPrice: '0',
			ensureOvmDeploymentGasLimit: true,
		});
	});

	describe('when both instances are deployed', () => {
		let mintableSynthetix, synthetix;
		let l2InitialTotalSupply;

		before('fetch Synthetix instances', async () => {
			synthetix = fetchContract({
				contract: 'Synthetix',
				source: 'Synthetix',
				instance: 0,
			});

			mintableSynthetix = fetchContract({
				contract: 'Synthetix',
				source: 'MintableSynthetix',
				instance: 1,
			});

			l2InitialTotalSupply = await mintableSynthetix.totalSupply();
		});

		it('the totalSupply on L2 should be right', async () => {
			assert.bnEqual(l2InitialTotalSupply, parseEther('100000000'));
		});

		describe('the address resolver is updated and the caches are synched on both layers', () => {
			before('fetch the required addresses and connect bridges', async () => {
				let predeployedContracts;
				await axios.get('http://localhost:8080/addresses.json').then(
					response => {
						predeployedContracts = response.data;
					},
					error => {
						console.log(error);
					}
				);
				// fetch messenger
				const l1ToL2MessengerAddress = predeployedContracts['Proxy__OVM_L1CrossDomainMessenger'];
				assert.equal(l1ToL2MessengerAddress, '0x6418E5Da52A3d7543d393ADD3Fa98B0795d27736'); // expected address sanity check
				// const l2ToL1MessengerAddress = predeployedContracts['OVM_L2CrossDomainMessenger'];
				const l2ToL1MessengerAddress = '0x4200000000000000000000000000000000000007'; // hardcoded address
				// fetch bridges
				const l1ToL2Bridge = fetchContract({ contract: 'SynthetixBridgeToOptimism', instance: 0 });
				const l2ToL1Bridge = fetchContract({ contract: 'SynthetixBridgeToBase', instance: 1 });

				await connectBridgesAndSyncCaches(
					l1ToL2MessengerAddress,
					l2ToL1MessengerAddress,
					l1ToL2Bridge,
					l2ToL1Bridge
				);
			});

			describe('when a user owns SNX on L1', () => {
				let accounts, l1User;

				before('transfer SNX to user', async () => {
					accounts = await l1Provider.listAccounts();
					l1User = l1Provider.getSigner(accounts[3]); // use 3rd account to avoid conflicts with the sequencer
					await (await synthetix.transfer(l1User._address, parseEther('100'), overrides)).wait();
				});

				it('should update the user balance', async () => {
					assert.bnEqual(await synthetix.balanceOf(l1User._address), parseEther('100'));
				});

				describe('when a user deposits SNX into the L1 bridge', () => {
					let l1ToL2Bridge;
					before('approve and deposit 100 SNX', async () => {
						l1ToL2Bridge = fetchContract({
							contract: 'SynthetixBridgeToOptimism',
							instance: 0,
							l1User,
						});
						// user must approve SynthetixBridgeToOptimism to transfer SNX on their behalf
						await (
							await fetchContract({ contract: 'Synthetix', instance: 0, l1User }).approve(
								l1ToL2Bridge.address,
								parseEther('10'),
								overrides
							)
						).wait();

						await (await l1ToL2Bridge.deposit(parseEther('10'), overrides)).wait();
					});

					it('the balances should be updated accordingly', async () => {
						assert.bnEqual(await synthetix.balanceOf(l1ToL2Bridge.address), parseEther('10'));
						assert.bnEqual(await synthetix.balanceOf(l1User._address), parseEther('90'));
					});

					describe('when the message is relayed to L2', () => {
						it('the amount should be credited', async () => {
							assert.bnEqual(await mintableSynthetix.balanceOf(l1User._address), parseEther('10'));
						});
					});

					describe('when the user owns SNX on L2', () => {
						let l2User;
						before('credit user with SNX', async () => {
							accounts = await l2Provider.listAccounts();
							l2User = l2Provider.getSigner(accounts[0]); // use the same account as in L1
							await (
								await mintableSynthetix.transfer(l2User._address, parseEther('100'), overrides)
							).wait();
						});

						it('the user balance should be updated accordingly', async () => {
							assert.bnEqual(await mintableSynthetix.balanceOf(l2User._address), parseEther('100'));
						});

						describe('when the user tries to withdraw', () => {
							let l2ToL1Bridge;
							before('initiate withdrawal', async () => {
								l2ToL1Bridge = fetchContract({
									contract: 'SynthetixBridgeToBase',
									instance: 1,
									l2User,
								});
								// initiate withdrawal on L2
								await l2ToL1Bridge.initiateWithdrawal(parseEther('10'), overrides);
							});

							it('the balances should be updated accordingly', async () => {
								assert.bnEqual(
									await mintableSynthetix.balanceOf(l2User._address),
									parseEther('90')
								);
							});
						});
					});
				});
			});
		});
	});
});