const chalk = require("chalk");

const banner = () => {
  const lines = [
    "███╗   ██╗███████╗██████╗ ██╗   ██╗██╗      ██████╗ ███╗   ██╗",
    "████╗  ██║██╔════╝██╔══██╗██║   ██║██║     ██╔═══██╗████╗  ██║",
    "██╔██╗ ██║█████╗  ██████╔╝██║   ██║██║     ██║   ██║██╔██╗ ██║",
    "██║╚██╗██║██╔══╝  ██╔══██╗██║   ██║██║     ██║   ██║██║╚██╗██║",
    "██║ ╚████║███████╗██████╔╝╚██████╔╝███████╗╚██████╔╝██║ ╚████║",
    "╚═╝  ╚═══╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝",
    "",
    "Nebulon - Private, milestone-based escrow protocol",
  ];
  console.log(chalk.cyan(lines.join("\n")));
  console.log("");
};

const keyValue = (label, value) => {
  const pad = label.padEnd(24, " ");
  console.log(`${pad} ${value}`);
};

const successMessage = (message = "Action completed successfully.") => {
  console.log(chalk.green(`√ ${message}`));
};

const errorMessage = (message = "Action failed.") => {
  console.error(chalk.red(`✖ ${message}`));
};

module.exports = {
  banner,
  keyValue,
  successMessage,
  errorMessage,
};
