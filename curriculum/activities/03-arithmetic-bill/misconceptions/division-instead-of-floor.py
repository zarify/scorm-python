price_cents = 4999
qty = 3
total_cents = price_cents * qty
gst_cents = total_cents / 10
print("Total: {:.2f}".format(total_cents / 100))
print("GST: {:.2f}".format(gst_cents / 100))
