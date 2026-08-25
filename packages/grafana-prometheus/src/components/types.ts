// Core Grafana history https://github.com/grafana/grafana/blob/v11.0.0-preview/public/app/plugins/datasource/prometheus/components/types.ts
import { type QueryEditorProps } from '@grafana/data';

import { type PrometheusDatasource } from '../datasource';
import { type QueryEditorCoauthoringRegistrationV1 } from '../query_coauthoring/internalCoauthoringContract';
import { type PromOptions, type PromQuery } from '../types';

export type PromQueryEditorProps = QueryEditorProps<PrometheusDatasource, PromQuery, PromOptions> & {
  /** @internal */
  unstable_queryEditorCoauthoringV1?: QueryEditorCoauthoringRegistrationV1<PromQuery>;
};
