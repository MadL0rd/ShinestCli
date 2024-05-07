#!/usr/bin/env node

import { Module } from '@nestjs/common'
import { CommandFactory } from 'nest-commander'
import { CommandsModule } from './commands/commands-module'
import { GenerationCommand } from './commands/generation-command'

@Module({
    imports: [CommandsModule],
    providers: [GenerationCommand],
})
export class AppModule {}

async function bootstrap() {
    console.clear()
    await CommandFactory.run(AppModule)
}

bootstrap()
