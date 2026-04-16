import chalk from "chalk";

export async function run(args: string[]) {
	console.log(chalk.yellow(`TODO: fetch vault secrets, inject env, exec: ${args.join(" ")}`));
}
