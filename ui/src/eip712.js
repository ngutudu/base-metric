// Mirrors test/flow.test.js's signing helpers exactly — same domains, same field lists.

async function adapterDomain(adapterAddress, chainId) {
  return { name: "BaseMetricPoR", version: "1", chainId, verifyingContract: adapterAddress };
}

export async function signLotAttestation(signer, adapterAddress, chainId, a) {
  const domain = await adapterDomain(adapterAddress, chainId);
  const types = {
    LotAttestation: [
      { name: "warehouseId", type: "uint256" },
      { name: "intentId", type: "uint256" },
      { name: "lotId", type: "uint256" },
      { name: "receiptNumber", type: "uint256" },
      { name: "commodity", type: "string" },
      { name: "nettKg6dec", type: "uint256" },
      { name: "allowanceRecipient", type: "address" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, a);
}

export async function signRevokeAttestation(signer, adapterAddress, chainId, r) {
  const domain = await adapterDomain(adapterAddress, chainId);
  const types = {
    RevokeAttestation: [
      { name: "intentId", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, r);
}

export async function signFinalReleaseAttestation(signer, adapterAddress, chainId, f) {
  const domain = await adapterDomain(adapterAddress, chainId);
  const types = {
    FinalReleaseAttestation: [
      { name: "intentId", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, f);
}

export async function signNavQuote(signer, targetAddress, chainId, quote, domainName) {
  const domain = { name: domainName, version: "1", chainId, verifyingContract: targetAddress };
  const types = {
    NavQuote: [
      { name: "navPriceUsdc6PerKg", type: "uint256" },
      { name: "validUntil", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, quote);
}
