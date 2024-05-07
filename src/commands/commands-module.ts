import { Module } from '@nestjs/common'
import { GenerationCommand } from './generation-command'

@Module({
    imports: [],
    controllers: [],
    providers: [GenerationCommand],
    exports: [GenerationCommand],
})
export class CommandsModule {}
