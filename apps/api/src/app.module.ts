import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminAgenciesController, AgenciesController } from './agencies/agencies.controller';
import { AgenciesService } from './agencies/agencies.service';
import { AgencyLifecycle } from './agencies/agency.lifecycle';
import { AgencyBillingService } from './agencies/billing.service';
import { PayoutsService } from './agencies/payouts.service';
import { KYC, MockKycAdapter } from './adapters/kyc';
import { MockPaystackAdapter, PAYMENTS } from './adapters/payments';
import { MockPostcodeAdapter, POSTCODE } from './adapters/postcode';
import { MockSmsAdapter, SMS } from './adapters/sms';
import { MockStorageAdapter, STORAGE } from './adapters/storage';
import { Audit } from './core/audit';
import { AuthGuard, Public, TokenService } from './core/auth';
import { Bus } from './core/bus';
import { CONFIG, type AppConfig } from './core/config';
import { Db } from './core/db';
import { ErrorFilter } from './core/http';
import { DevController } from './dev/dev.controller';
import { MockTranslateAdapter, TRANSLATE } from './adapters/translate';
import { StatementsController } from './statements/statements.controller';
import { StatementsService } from './statements/statements.service';
import { AdminFinesController, AdminSupportController, CitizenController } from './citizen/citizen.controller';
import { DonationsService } from './citizen/donations.service';
import { FinesService } from './citizen/fines.service';
import { AdminInstallsController, AdminRepairsController, HomeController } from './citizen/home.controller';
import { BillingService } from './citizen/billing.service';
import { HomeService } from './citizen/home.service';
import { IncidentRepo } from './incidents/incident.repo';
import { IncidentsController } from './incidents/incidents.controller';
import { IncidentsService } from './incidents/incidents.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { MeController } from './me/me.controller';
import { OfficersController } from './officers/officers.controller';
import { OfficersService } from './officers/officers.service';
import { OfficerWorkController } from './officers/work.controller';
import { OfficerWorkService } from './officers/work.service';
import { PlacesController } from './places/places.controller';
import { IssuesService } from './reports/issues.service';
import { ReportsController } from './reports/reports.controller';
import { TipsService } from './reports/tips.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { LearnController } from './learn/learn.controller';
import { LearnService } from './learn/learn.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { AdminBountyFeeController, BountiesController } from './reports/bounties.controller';
import { BountiesService } from './reports/bounties.service';
import { BriefController } from './reports/brief.controller';
import { BriefService } from './reports/brief.service';
import { RewardsController } from './rewards/rewards.controller';
import { RewardsService } from './rewards/rewards.service';
import { WalletController } from './wallet/wallet.controller';
import { WalletService } from './wallet/wallet.service';
import { WithdrawalsService } from './wallet/withdrawals.service';

@Public()
@Controller('health')
class HealthController {
  constructor(@Inject(Db) private readonly db: Db) {}
  @Get()
  async health() {
    await this.db.query('select 1');
    return { ok: true };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        CitizenController,
        StatementsController,
        AdminFinesController,
        AdminSupportController,
        HomeController,
        AdminRepairsController,
        AdminInstallsController,
        AuthController,
        IncidentsController,
        WalletController,
        MeController,
        PlacesController,
        OfficersController,
        OfficerWorkController,
        ReportsController,
        AgenciesController,
        AdminAgenciesController,
        MediaController,
        LearnController,
        RewardsController,
        BriefController,
        BountiesController,
        AdminBountyFeeController,
        JobsController,
        ...(config.devTools ? [DevController] : []),
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        DonationsService,
        BillingService,
        StatementsService,
        { provide: TRANSLATE, useValue: new MockTranslateAdapter() },
        FinesService,
        HomeService,
        Db,
        Bus,
        Audit,
        TokenService,
        AuthService,
        IncidentRepo,
        IncidentsService,
        WalletService,
        WithdrawalsService,
        OfficersService,
        OfficerWorkService,
        TipsService,
        IssuesService,
        AgencyLifecycle,
        AgencyBillingService,
        PayoutsService,
        AgenciesService,
        MediaService,
        LearnService,
        RewardsService,
        BriefService,
        BountiesService,
        JobsService,
        // Mock adapters — swap each for the real provider once its contract is signed.
        { provide: POSTCODE, useValue: new MockPostcodeAdapter() },
        { provide: KYC, useValue: new MockKycAdapter() },
        { provide: PAYMENTS, useValue: new MockPaystackAdapter(config.paystackSecret, config.publicBaseUrl) },
        { provide: SMS, useValue: new MockSmsAdapter() },
        { provide: STORAGE, useValue: new MockStorageAdapter(config.publicBaseUrl) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
