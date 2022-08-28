import chalk from 'chalk'

export const log = (message: any, ...optionalParams: any[]) => {
    console.log(message, ...optionalParams)
}

export const debug = (message: any, ...optionalParams: any[]) => {
    console.debug(chalk.cyan('[DEBUG]'), message, ...optionalParams)
}

export const info = (message: any, ...optionalParams: any[]) => {
    console.info(chalk.blue('[INFO]'), message, ...optionalParams)
}

export const warn = (message: any, ...optionalParams: any[]) => {
    console.warn(chalk.magenta('[WARN]'), message, ...optionalParams)
}

export const error = (message: any, ...optionalParams: any[]) => {
    console.error(chalk.red('[ERROR]'), message, ...optionalParams)
}

export const fatal = (message: any, ...optionalParams: any[]) => {
    console.error(chalk.red('[FATAL]'), message, ...optionalParams)
}
