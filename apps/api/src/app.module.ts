import { Controller, Get, Inject, Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AdminAgenciesController, AgenciesController } from './agencies/agencies.controller';
import { AgenciesService } from './agencies/agencies.service';
import { AgencyOpsController } from './agencies/agency-ops.controller';
import { AgencyOpsService } from './agencies/agency-ops.service';
import { AgencyLifecycle } from './agencies/agency.lifecycle';
import { AgencyBillingService } from './agencies/billing.service';
import { PayoutsService } from './agencies/payouts.service';
import { KYC, MockKycAdapter } from './adapters/kyc';
import { PAYMENTS, paymentsFromEnv } from './adapters/payments';
import { MockPostcodeAdapter, POSTCODE } from './adapters/postcode';
import { LoggedSmsAdapter, SMS, smsFromEnv } from './adapters/sms';
import { PUSH, pushFromEnv } from './adapters/push';
import { PushController } from './push/push.controller';
import { PushService } from './push/push.service';
import { MockWhatsAppAdapter, WHATSAPP } from './adapters/whatsapp';
import { MockStorageAdapter, STORAGE } from './adapters/storage';
import { FleetController } from './fleet/fleet.controller';
import { FleetService } from './fleet/fleet.service';
import { IncidentMessagesController } from './incidents/messages.controller';
import { Audit } from './core/audit';
import { AuthGuard, Public, TokenService } from './core/auth';
import { Bus } from './core/bus';
import { CONFIG, type AppConfig } from './core/config';
import { Db } from './core/db';
import { ErrorFilter } from './core/http';
import { DevController } from './dev/dev.controller';
import { AdminController } from './dashboards/admin.controller';
import { AdminOpsService } from './dashboards/admin-ops.service';
import { AdminOversightService } from './dashboards/admin-oversight.service';
import { DashboardsController } from './dashboards/dashboards.controller';
import { OverviewService } from './dashboards/overview.service';
import { StationService } from './dashboards/station.service';
import { MockTranslateAdapter, TRANSLATE } from './adapters/translate';
import { AnthropicAssistantAdapter, ASSISTANT, MockAssistantAdapter } from './adapters/assistant';
import { AdminHelpChatController, HelpChatController } from './help/help.controller';
import { HelpService } from './help/help.service';
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
import { IncidentMapController } from './incidents/map.controller';
import { ROUTING, routingFromEnv } from './adapters/routing';
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
import { ItemsController } from './items/items.controller';
import { ItemsService } from './items/items.service';
import { ReportsController } from './reports/reports.controller';
import { TipsService } from './reports/tips.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { LearnController } from './learn/learn.controller';
import { LearnService } from './learn/learn.service';
import { MediaController } from './media/media.controller';
import { AgencyLogoController } from './agencies/logo.controller';
import { MediaService } from './media/media.service';
import { AdminBountyFeeController, BountiesController } from './reports/bounties.controller';
import { BountiesService } from './reports/bounties.service';
import { BriefController } from './reports/brief.controller';
import { BriefService } from './reports/brief.service';
import { RewardsController, StationMoneyController } from './rewards/rewards.controller';
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
        PushController,
        AgencyLogoController,
        CitizenController,
        DashboardsController,
        AdminController,
        AgencyOpsController,
        HelpChatController,
        IncidentMapController,
        IncidentMessagesController,
        FleetController,
        AdminHelpChatController,
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
        ItemsController,
        AgenciesController,
        AdminAgenciesController,
        MediaController,
        LearnController,
        RewardsController,
        StationMoneyController,
        BriefController,
        BountiesController,
        AdminBountyFeeController,
        JobsController,
        ...(config.devTools ? [DevController] : []),
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        DonationsService,
        StationService,
        FleetService,
        OverviewService,
        AdminOpsService,
        AgencyOpsService,
        HelpService,
        AdminOversightService,
        BillingService,
        StatementsService,
        { provide: TRANSLATE, useValue: new MockTranslateAdapter() },
        { provide: ROUTING, useValue: routingFromEnv(config.env, process.env.ROUTING_URL) },
        // The help assistant uses Claude when an Anthropic key is configured (never in tests).
        { provide: ASSISTANT, useValue: config.env !== 'test' && (process.env.ANTHROPIC_API_KEY || process.env.ASSISTANT_PROVIDER === 'anthropic') ? new AnthropicAssistantAdapter() : new MockAssistantAdapter() },
        { provide: WHATSAPP, useValue: new MockWhatsAppAdapter() },
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
        ItemsService,
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
        PushService,
        // Mock adapters — swap each for the real provider once its contract is signed.
        { provide: POSTCODE, useValue: new MockPostcodeAdapter() },
        { provide: KYC, useValue: new MockKycAdapter() },
        // Paystack with a real secret key; the mock (with its test checkout) in development and tests.
        { provide: PAYMENTS, useValue: paymentsFromEnv(config.env, config.paystackSecret, process.env, config.publicBaseUrl) },
        // Termii in production (SMS_PROVIDER), the mock in development and tests; every send is logged.
        // Web push with VAPID keys in production; a mock outbox in development without keys and in tests.
        { provide: PUSH, useValue: pushFromEnv(config.env, process.env) },
        { provide: SMS, useFactory: (db: Db) => new LoggedSmsAdapter(smsFromEnv(config.env, process.env), db.pool), inject: [Db] },
        { provide: STORAGE, useValue: new MockStorageAdapter(config.publicBaseUrl) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}
