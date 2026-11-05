exports.isSocialMediaAssetUrl = function isSocialMediaAssetUrl(link) {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/\.$/, "");
    return ["fbcdn.net", "cdninstagram.com"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  };
}
