package querydata

func SetReplySizeGuard(q *QueryData, on bool, limit int64) {
	q.replySizeGuard, q.replySizeLimit = on, limit
}
