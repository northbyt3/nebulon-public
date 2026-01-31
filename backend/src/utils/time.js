const nowSeconds = () => Math.floor(Date.now() / 1000);
const daysToSeconds = (days) => Math.floor(days * 24 * 60 * 60);

module.exports = {
  nowSeconds,
  daysToSeconds,
};
