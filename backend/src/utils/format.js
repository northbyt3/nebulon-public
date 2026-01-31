const formatContract = (row) => {
  if (!row) {
    return row;
  }
  let milestones = null;
  if (row.milestones_json) {
    try {
      milestones = JSON.parse(row.milestones_json);
    } catch {
      milestones = null;
    }
  }
  const { milestones_json, ...rest } = row;
  return { ...rest, milestones };
};

const formatContracts = (rows) => rows.map(formatContract);

module.exports = {
  formatContract,
  formatContracts,
};
