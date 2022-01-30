import { MaxUint256 } from '@ethersproject/constants';
import axios from 'axios';
import { ethers } from 'ethers';
import ABI from 'human-standard-token-abi';
import debounce from 'lodash.debounce';
import { stringifyUrl } from 'query-string';
import {
  approve,
  cBridgeEndpoint,
  cbridgeInitialState,
  Chain,
  EvmChain,
  formatDecimals,
  getTokenBalCbridge,
  getTokenInfo,
  getTransferConfigs,
  PeggedPairConfig,
  pushToSelectableChains,
  Quotation,
  mintOrBurn,
  sortChainName,
  getCanonicalMinAndMaxAmount,
} from 'src/c-bridge';
import { useStore } from 'src/store';
import { setupNetwork, nativeCurrency } from 'src/web3';
import { computed, ref, watch, watchEffect, onUnmounted } from 'vue';
import Web3 from 'web3';
import { objToArray } from './helper/common';
import { calUsdAmount } from './helper/price';

const { Ethereum, Astar } = EvmChain;

export function useCbridge() {
  const srcChain = ref<Chain>(cbridgeInitialState[Ethereum]);
  const destChain = ref<Chain>(cbridgeInitialState[Astar]);
  const srcChains = ref<Chain[] | null>(null);
  const destChains = ref<Chain[] | null>(null);
  const selectedNetwork = ref<number | null>(null);
  const chains = ref<Chain[] | null>(null);
  const tokens = ref<PeggedPairConfig[] | null>(null);
  const tokensObj = ref<any | null>(null);
  const selectedToken = ref<PeggedPairConfig | null>(null);
  const selectedTokenBalance = ref<string | null>(null);
  const modal = ref<'src' | 'dest' | 'token' | null>(null);
  const amount = ref<string | null>(null);
  const quotation = ref<Quotation | null>(null);
  const usdValue = ref<number>(0);
  const isApprovalNeeded = ref<boolean>(true);
  const isDisabledBridge = ref<boolean>(true);

  const store = useStore();
  const isH160 = computed(() => store.getters['general/isH160Formatted']);
  const selectedAddress = computed(() => store.getters['general/selectedAddress']);

  const handleApprove = async () => {
    try {
      const provider = typeof window !== 'undefined' && window.ethereum;
      if (!selectedToken.value || !selectedToken.value || !srcChain.value || !provider) return;
      if (srcChain.value.id !== selectedNetwork.value) {
        throw Error('invalid network');
      }

      const hash = await approve({
        address: selectedAddress.value,
        selectedToken: selectedToken.value,
        srcChainId: srcChain.value.id,
        provider,
      });
      const msg = `Transaction submitted at transaction hash #${hash}`;
      store.dispatch('general/showAlertMsg', { msg, alertType: 'success' });
    } catch (error: any) {
      console.error(error.message);
      store.dispatch('general/showAlertMsg', {
        msg: error.message || 'Something went wrong',
        alertType: 'error',
      });
    }
  };

  const closeModal = () => modal.value === null;
  const openModal = (scene: 'src' | 'dest' | 'token') => (modal.value = scene);
  const selectToken = (token: PeggedPairConfig) => {
    selectedToken.value = token;
    console.log('selectedToken.value', selectedToken.value);
    modal.value = null;
    isApprovalNeeded.value = true;
  };

  const getSelectedTokenBal = async () => {
    if (!selectedAddress.value || !srcChain.value || !selectedToken.value) return '0';

    return await getTokenBalCbridge({
      address: selectedAddress.value,
      srcChainId: srcChain.value.id,
      selectedToken: selectedToken.value,
    }).catch((error: any) => {
      console.error(error.message);
      return '0';
    });
  };

  const getEstimation = async () => {
    try {
      if (!srcChain.value || !destChain.value || !selectedToken.value) return;
      const numAmount = Number(amount.value ?? 0.000001);
      const isValidAmount = !isNaN(numAmount);
      if (!isValidAmount) return;

      const tokenInfo = getTokenInfo({
        srcChainId: srcChain.value.id,
        selectedToken: selectedToken.value,
      });

      const token_symbol = tokenInfo.token.symbol;
      const amt = ethers.utils.parseUnits(numAmount.toString(), tokenInfo.token.decimal).toString();

      const usr_addr = isH160.value
        ? selectedAddress.value
        : '0xaa47c83316edc05cf9ff7136296b026c5de7eccd';

      // Memo: dummy due to slippage is not be effective to `is_pagged: true`
      const slippage_tolerance = 3000;

      const url = stringifyUrl({
        url: cBridgeEndpoint + '/estimateAmt',
        query: {
          src_chain_id: srcChain.value.id,
          dst_chain_id: destChain.value.id,
          token_symbol,
          amt,
          usr_addr,
          slippage_tolerance,
          is_pegged: true,
        },
      });
      const { data } = await axios.get<Quotation>(url);

      const baseFee = formatDecimals({
        amount: ethers.utils.formatUnits(data.base_fee, tokenInfo.token.decimal).toString(),
        decimals: 8,
      });

      const estimatedReceiveAmount = formatDecimals({
        amount: ethers.utils
          .formatUnits(data.estimated_receive_amt, tokenInfo.token.decimal)
          .toString(),
        decimals: 6,
      });

      const { min, max } = await getCanonicalMinAndMaxAmount({
        srcChainId: srcChain.value.id,
        selectedToken: selectedToken.value,
      });

      quotation.value = {
        ...data,
        base_fee: String(baseFee),
        estimated_receive_amt: String(estimatedReceiveAmount),
        minAmount: min,
        maxAmount: max,
      };
      console.log('quotation', quotation.value);
    } catch (error) {
      console.log(error);
    }
  };

  const updateEstimation = setInterval(() => {
    getEstimation();
  }, 15 * 1000);

  const inputHandler = debounce((event) => {
    amount.value = event.target.value;
  }, 500);

  const toMaxAmount = async () => {
    amount.value = await getSelectedTokenBal();
  };

  const selectChain = async (chainId: number) => {
    if (!chains.value) return;
    const isSrcChain = modal.value === 'src';
    const chain = chains.value.find((it) => it.id === chainId);
    if (!chain) return;

    if (isSrcChain) {
      srcChain.value = chain;
    } else {
      destChain.value = chain;
    }
    modal.value = null;
  };

  const reverseChain = () => {
    const fromChain = srcChain.value;
    srcChain.value = destChain.value;
    destChain.value = fromChain;
  };

  const updateBridgeConfig = async () => {
    const data = await getTransferConfigs();
    const supportChain = data && data.supportChain;
    const tokens = data && data.tokens;

    if (!supportChain || !tokens) return;
    srcChain.value = supportChain.find((it) => it.id === Ethereum) as Chain;
    destChain.value = supportChain.find((it) => it.id === Astar) as Chain;

    sortChainName(supportChain);
    srcChains.value = supportChain;
    chains.value = supportChain;
    tokensObj.value = tokens;
  };

  const watchSelectableChains = () => {
    if (!srcChain.value || !destChain.value || chains.value === null) {
      return;
    }

    if (destChain.value.id === srcChain.value.id) {
      const tokens = objToArray(tokensObj.value[srcChain.value.id]).find(
        (it) => Object.keys(it).length !== 0
      );
      const chainId =
        srcChain.value.id === tokens[0].org_chain_id
          ? tokens[0].pegged_chain_id
          : tokens[0].org_chain_id;
      destChain.value = chains.value.find((it) => it.id === chainId) as Chain;
    }

    if (srcChain.value.id !== Astar) {
      destChain.value = chains.value.find((it) => it.id === Astar) as Chain;
    }

    const selectableChains: Chain[] = [];
    pushToSelectableChains({
      tokensObj: tokensObj.value,
      srcChainId: srcChain.value.id,
      selectableChains,
      supportChains: chains.value,
    });

    sortChainName(selectableChains);
    destChains.value = selectableChains;
    tokens.value = tokensObj.value[srcChain.value.id][destChain.value.id];
    selectedToken.value = tokens.value && tokens.value[0];
    isApprovalNeeded.value = true;
  };

  const bridge = async () => {
    try {
      const provider = typeof window !== 'undefined' && window.ethereum;
      if (
        !isH160.value ||
        !selectedAddress.value ||
        !selectedToken.value ||
        !srcChain.value ||
        !amount.value ||
        !provider
      ) {
        throw Error('Something went wrong');
      }
      const hash = await mintOrBurn({
        provider,
        selectedToken: selectedToken.value,
        amount: amount.value,
        srcChainId: srcChain.value.id,
        address: selectedAddress.value,
      });
      const msg = `Transaction submitted at transaction hash #${hash}`;
      store.dispatch('general/showAlertMsg', { msg, alertType: 'success' });
    } catch (error: any) {
      console.error(error.message);
      store.dispatch('general/showAlertMsg', {
        msg: error.message || 'Something went wrong',
        alertType: 'error',
      });
    }
  };

  watchEffect(async () => {
    await updateBridgeConfig();
  });

  watchEffect(() => {
    watchSelectableChains();
  });

  watchEffect(async () => {
    if (!selectedToken.value || !amount.value) return;
    usdValue.value = await calUsdAmount({
      amount: Number(amount.value),
      symbol: selectedToken.value.org_token.token.symbol,
    });
  });

  watchEffect(async () => {
    getEstimation();
  });

  watch(
    [srcChain, selectedToken, selectedAddress, selectedNetwork],
    async () => {
      selectedTokenBalance.value = String(
        formatDecimals({
          amount: await getSelectedTokenBal(),
          decimals: 6,
        })
      );
    },
    { immediate: true }
  );

  watch(
    [srcChain, isH160],
    async () => {
      setTimeout(async () => {
        isH160.value && srcChain.value && (await setupNetwork(srcChain.value.id));
      }, 800);
    },
    { immediate: false }
  );

  watchEffect(async () => {
    if (!isH160.value) return;
    const provider = typeof window !== 'undefined' && window.ethereum;
    const web3 = new Web3(provider as any);
    const chainId = await web3.eth.getChainId();
    selectedNetwork.value = chainId;

    provider &&
      provider.on('chainChanged', (chainId: string) => {
        selectedNetwork.value = Number(chainId);
      });
  });

  watchEffect(() => {
    if (!quotation.value || !srcChain.value) return;

    if (
      selectedNetwork.value !== srcChain.value.id ||
      0 >= Number(quotation.value.estimated_receive_amt)
    ) {
      isDisabledBridge.value = true;
    } else {
      isDisabledBridge.value = false;
    }
  });

  // Memo: Check approval
  watchEffect(() => {
    let cancelled = false;
    const provider = typeof window !== 'undefined' && window.ethereum;
    if (
      !isH160.value ||
      !srcChain.value ||
      !selectedToken.value ||
      !selectedAddress.value ||
      !provider
    ) {
      return;
    }

    const address = selectedAddress.value;
    const tokenInfo = getTokenInfo({
      srcChainId: srcChain.value.id,
      selectedToken: selectedToken.value,
    });
    const token = tokenInfo.token.address;
    const spender =
      selectedToken.value.org_chain_id === selectedNetwork.value
        ? selectedToken.value.pegged_deposit_contract_addr
        : selectedToken.value.pegged_burn_contract_addr;

    const checkIsApproved = async (): Promise<boolean | null> => {
      if (!token) return null;
      try {
        const web3 = new Web3(provider as any);
        const contract = new web3.eth.Contract(ABI, token);
        const allowance = await contract.methods.allowance(address, spender).call();
        return allowance === MaxUint256.toString();
      } catch (err: any) {
        console.error(err.message);
        return null;
      }
    };

    const checkPeriodically = async () => {
      if (cancelled || !srcChain.value || isApprovalNeeded.value === false) return;
      isApprovalNeeded.value = true;
      if (nativeCurrency[srcChain.value.id].name === tokenInfo.token.symbol) {
        isApprovalNeeded.value = false;
        return;
      }

      const result = await checkIsApproved();
      if (cancelled) return;
      isApprovalNeeded.value = !!!result;
      setTimeout(checkPeriodically, 15000);
    };

    checkPeriodically();

    return () => {
      cancelled = true;
    };
  });

  onUnmounted(() => {
    clearInterval(updateEstimation);
  });

  return {
    destChains,
    srcChains,
    srcChain,
    destChain,
    chains,
    tokens,
    modal,
    selectedToken,
    selectedTokenBalance,
    amount,
    quotation,
    isApprovalNeeded,
    selectedNetwork,
    isDisabledBridge,
    usdValue,
    reverseChain,
    closeModal,
    openModal,
    selectChain,
    selectToken,
    inputHandler,
    toMaxAmount,
    handleApprove,
    bridge,
  };
}
