import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SupplierModule } from '../supplier/supplier.module';
import { PublicTendersController, SupplierTendersController, TendersController } from './tenders.controller';
import { TendersService } from './tenders.service';

/**
 * The separate tender UI's API (see TendersService). No new workflow: tenders
 * are still open-tender RFQs, bids are still quotations.
 *
 * SupplierModule is imported for SupplierGuard; AuthModule for JwtAuthGuard.
 */
@Module({
  imports: [AuthModule, AttachmentsModule, SupplierModule],
  controllers: [TendersController, PublicTendersController, SupplierTendersController],
  providers: [TendersService],
})
export class TendersModule {}
