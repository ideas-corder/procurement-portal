import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';
import { SupplierAccountService } from './supplier-account.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.API_JWT_SECRET || 'dev-only-jwt-secret-change-me',
      signOptions: { expiresIn: process.env.API_JWT_TTL || '12h' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, SupplierAccountService],
  exports: [AuthService, JwtAuthGuard, JwtModule, SupplierAccountService],
})
export class AuthModule {}
