price_cents = 4999
qty = 3
total_cents = price_cents * qty
gst = total_cents / 10 / 100
print("Total: {:.2f}".format(total_cents / 100))
print("GST: " + str(gst))
