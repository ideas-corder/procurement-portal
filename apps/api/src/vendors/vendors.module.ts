import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';
import { VendorGovernanceService } from './vendor-governance.service';
import { VendorApplicationsService } from './vendor-applications.service';

@Module({
  imports: [AuthModule],
  controllers: [VendorsController],
  providers: [VendorsService, VendorGovernanceService, VendorApplicationsService],
  exports: [VendorApplicationsService],
})
export class VendorsModule {}
