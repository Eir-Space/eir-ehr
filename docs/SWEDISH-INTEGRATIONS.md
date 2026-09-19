# Who Owns The Swedish Integrations?

Checked against primary service-owner documentation on 2026-09-19. This is an onboarding map, not a claim that Eir has agreements, approval or production access. Routes and requirements must be confirmed for the partner provider and selected service scope.

## Responsible Parties

| Integration                                     | Service owner and counterparties                                                                                                                      | Eir's practical next action                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Professional identity: SITHS                    | Inera; the healthcare organization's SITHS administrator and approved intermediary where applicable. Private healthcare providers use an ombud route. | Choose the partner's actual identity provider/intermediary; obtain the test integration and assurance requirements.                                                 |
| Organizations and professional assignments: HSA | Inera; the healthcare organization's HSA administrator or intermediary                                                                                | Map provider/unit identifiers and approved assignments; establish authoritative provisioning, updates and revocation.                                               |
| NPÖ and 1177 journal                            | Inera; participating healthcare providers; their supplier/agent or regional integration organization                                                  | Select producer/consumer scope, confirm agent/customer arrangements and applicable service contracts. These are separate services, not one generic FHIR connection. |
| NLL and prescription services                   | E-hälsomyndigheten; system supplier in the approval process; healthcare organization using the approved system                                        | Open a supplier onboarding discussion with a defined read/prescribing scope and a provider partner.                                                                 |
| Webcert                                         | Inera; healthcare provider or system-supplier agent; regional route where applicable                                                                  | Agree the actual integration route and pilot customers before implementation.                                                                                       |
| Laboratory orders/results                       | The laboratory serving the clinic; its LIS/interface supplier; regional integration organization where applicable                                     | Obtain the real message contract, test endpoints, identifiers, analysis catalogue, acknowledgements and operational escalation agreement.                           |
| Referrals                                       | Sending/receiving providers and their systems; Inera where Elektronisk remiss is the chosen route                                                     | Select one destination and transport, including status/acknowledgement semantics and operational ownership.                                                         |

Sources: [SITHS connection routes](https://www.inera.se/tjanster/alla-tjanster-a-o/siths-identifieringstjanst/), [HSA's role](https://www.inera.se/tjanster/alla-tjanster-a-o/katalogtjanst-hsa/om-katalogtjanst-hsa/), [Inera's agent model](https://www.inera.se/tjanster/stod-i-teknisk-anslutning/anslut-via-agent/), [NPÖ](https://www.inera.se/tjanster/alla-tjanster-a-o/npo---nationell-patientoversikt/), [E-hälsomyndigheten system approval](https://samarbetsyta.ehalsomyndigheten.se/handboken/latest/godkaennande-av-anslutande-system), [Webcert integration](https://www.inera.se/tjanster/alla-tjanster-a-o/intygstjanster/webcert/for-dig-som-ska-integrera-webcert-i-ett-vardinformationssystem/), [Elektronisk remiss](https://www.inera.se/tjanster/alla-tjanster-a-o/elektronisk-remiss/).

Laboratory arrangements are destination-specific. For example, Karolinska describes agreements and interconnected systems for electronic result delivery in its [referral guidance](https://www.karolinska.se/vard/funktion/funktion-medicinsk-diagnostik-karolinska/patologi-och-cancerdiagnostik/punktionsmottagning-sodersjukhuset/punktionsmottagningarna---remissinformation/). Do not assume that example is the universal Swedish laboratory contract.

## The Healthcare Partner Is Essential

The first project stakeholder should be a named Swedish healthcare provider with a clinical lead, IT/integration lead, identity administrators, information-security owner and privacy expertise. The provider determines its care workflows and access needs; it is responsible for the personal-data processing it performs. [IMY: provider responsibility](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/vard/den-registrerades-rattigheter-for-vardgivare/), [IMY: access allocation](https://www.imy.se/verksamhet/dataskydd/dataskydd-pa-olika-omraden/vard/informationssakerhet--for-vardgivare/tilldelning-av-behorighet-till-uppgifter-om-patienter--for-vardgivare/).

Recommended division for Eir: a named supplier/integration lead implements and maintains adapters; a clinical owner validates workflows and hazards; an operations owner handles availability, backup, alerts and incidents. Open-source licensing does not remove those responsibilities. IMY is a regulator, not the operator of an API connection or a general EHR approval service.

## Recommended First Conversations

1. A Swedish primary-care provider willing to be a design and test partner, initially using fictional cases.
2. That provider's SITHS/HSA/IdP counterpart, to establish verified staff identity and assignment updates.
3. The provider's laboratory and integration team, to scope one complete order/result/correction workflow.
4. Inera's supplier/agent onboarding and E-hälsomyndigheten's system-approval team, in parallel with clinical validation.

The [national infrastructure portal](https://portal.ehalsomyndigheten.se/) is also relevant for emerging national/EHDS infrastructure. It does not replace the service-specific onboarding paths above.
