#!/usr/bin/env node
import 'reflect-metadata'

import { Module } from '@nestjs/common'
import { CommandFactory } from 'nest-commander'
import { CommandsModule } from './commands/commands-module.js'

@Module({
    imports: [CommandsModule],
    providers: [],
})
export class AppModule {}

async function bootstrap() {
    console.clear()
    await CommandFactory.run(AppModule)
}

bootstrap()
